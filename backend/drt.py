from __future__ import annotations
import asyncio
import json
import traceback
from typing import AsyncGenerator

import numpy as np
from scipy.optimize import curve_fit, nnls
from scipy.signal import find_peaks

from .file_handler import load_eis_data
from .models import DRTRequest, DRTResult, DRTSingleRequest, LCurveRequest


def _build_kernel(frequencies: np.ndarray, n_tau: int = 100):
    """Return (log_tau, K_im, K_re, L) for Tikhonov DRT.

    K_im: imaginary kernel  (ωτ)/(1+(ωτ)²) · ln10 · Δlog10τ
    K_re: real kernel       1/(1+(ωτ)²) · ln10 · Δlog10τ
    L:    second-derivative regularization matrix
    """
    omega = 2 * np.pi * frequencies
    log_tau_min = np.log10(1.0 / omega.max()) - 1.0
    log_tau_max = np.log10(1.0 / omega.min()) + 1.0
    log_tau = np.linspace(log_tau_min, log_tau_max, n_tau)
    tau = 10.0 ** log_tau
    d_log10 = log_tau[1] - log_tau[0]
    wt = omega[:, None] * tau[None, :]
    scale = np.log(10) * d_log10
    K_im = wt / (1.0 + wt ** 2) * scale
    K_re = 1.0 / (1.0 + wt ** 2) * scale
    L = np.zeros((n_tau - 2, n_tau))
    idx = np.arange(n_tau - 2)
    L[idx, idx] = 1.0
    L[idx, idx + 1] = -2.0
    L[idx, idx + 2] = 1.0
    return log_tau, K_im, K_re, L


def _solve_tikhonov(K: np.ndarray, L: np.ndarray, rhs: np.ndarray, lambda_reg: float) -> np.ndarray:
    """Non-negative Tikhonov solve: min ‖Kγ − rhs‖² + λ‖Lγ‖²  s.t. γ ≥ 0.

    Solved as NNLS on the augmented system [K; √λ·L] γ = [rhs; 0]. Clipping the
    unconstrained solution to zero is NOT equivalent — negative lobes of the
    unconstrained solution carry mass that must be redistributed, otherwise peak
    amplitudes and positions are distorted.
    """
    A_aug = np.vstack([K, np.sqrt(lambda_reg) * L])
    b_aug = np.concatenate([rhs, np.zeros(L.shape[0])])
    try:
        gamma, _ = nnls(A_aug, b_aug, maxiter=10 * A_aug.shape[1])
        return gamma
    except RuntimeError:
        # NNLS failed to converge — fall back to the clipped unconstrained solution.
        A = K.T @ K + lambda_reg * (L.T @ L)
        return np.maximum(np.linalg.solve(A, K.T @ rhs), 0.0)


def _solve_drt_system(
    frequencies: np.ndarray,
    Z: np.ndarray,
    K_im: np.ndarray,
    K_re: np.ndarray,
    L: np.ndarray,
    lambda_reg: float,
    mode: str,
) -> tuple[np.ndarray, float | None, float | None]:
    """Solve the DRT in the requested mode.  Returns (gamma, r_inf, inductance).

    'imag'    — imaginary-only kernel (r_inf/inductance are None).
    'complex' — joint fit of both parts.  Unknowns x = [γ, R∞, L_series], all
                ≥ 0, solved as one NNLS problem:
                    Z'  = R∞ + K_re·γ
                    −Z'' = K_im·γ − ω·L_series
                Regularisation applies to γ only.  Using both parts doubles the
                data constraining γ and makes the result robust to noise that
                only corrupts one component.
    """
    if mode != 'complex':
        return _solve_tikhonov(K_im, L, -Z.imag, lambda_reg), None, None

    omega = 2 * np.pi * frequencies
    n_f, n_tau = K_im.shape
    n_reg = L.shape[0]

    A = np.zeros((2 * n_f + n_reg, n_tau + 2))
    A[:n_f, :n_tau]       = K_re
    A[:n_f, n_tau]        = 1.0          # R∞ column (real part only)
    A[n_f:2 * n_f, :n_tau] = K_im
    A[n_f:2 * n_f, n_tau + 1] = -omega   # inductance column (imag part only)
    A[2 * n_f:, :n_tau]   = np.sqrt(lambda_reg) * L
    b = np.concatenate([Z.real, -Z.imag, np.zeros(n_reg)])

    try:
        x, _ = nnls(A, b, maxiter=10 * A.shape[1])
    except RuntimeError:
        # Fall back to a clipped ridge solution.
        AtA = A.T @ A + 1e-12 * np.eye(A.shape[1])
        x = np.maximum(np.linalg.solve(AtA, A.T @ b), 0.0)

    return x[:n_tau], float(x[n_tau]), float(x[n_tau + 1])


def _merge_nearby_peaks(log_tau: np.ndarray, gamma: np.ndarray, peaks: list[dict]) -> list[dict]:
    """Merge adjacent peaks that are not clearly separated in the spectrum.

    Two peaks are merged when either:
    - The valley between their centers is ≥ 40% of the shorter peak (humps, not distinct arcs)
    - Their Gaussians overlap: |μ_1 - μ_2| < σ_1 + σ_2

    Iterates until stable so that three-way humps collapse to one in a single call.
    """
    if len(peaks) <= 1:
        return peaks

    changed = True
    while changed and len(peaks) > 1:
        changed = False
        peaks.sort(key=lambda p: p["log_tau_center"])
        out: list[dict] = []
        i = 0
        while i < len(peaks):
            if i + 1 >= len(peaks):
                out.append(peaks[i])
                i += 1
                break
            p1, p2 = peaks[i], peaks[i + 1]
            mu1, mu2 = p1["log_tau_center"], p2["log_tau_center"]

            # Trough: minimum gamma between the two peak centers
            idx1 = int(np.argmin(np.abs(log_tau - mu1)))
            idx2 = int(np.argmin(np.abs(log_tau - mu2)))
            if idx1 > idx2:
                idx1, idx2 = idx2, idx1
            trough = float(gamma[idx1:idx2 + 1].min()) if idx2 > idx1 else float(gamma[idx1])
            smaller_amp = min(p1["amplitude"], p2["amplitude"])
            shallow = smaller_amp > 1e-30 and (trough / smaller_amp) > 0.55

            # Gaussian overlap: one peak's σ must fully cover the other's center
            overlap = abs(mu2 - mu1) < max(p1["sigma"], p2["sigma"])

            if shallow or overlap:
                total_A = p1["amplitude"] + p2["amplitude"]
                new_mu = (p1["amplitude"] * mu1 + p2["amplitude"] * mu2) / total_A
                span = abs(mu2 - mu1)
                new_sigma = max(p1["sigma"], p2["sigma"], span * 0.5)
                out.append({
                    "amplitude":      float(total_A),
                    "log_tau_center": float(new_mu),
                    "tau_center":     float(10.0 ** new_mu),
                    "sigma":          float(new_sigma),
                    "r2":             min(p1["r2"], p2["r2"]),
                    "_merged_count":  p1.get("_merged_count", 1) + p2.get("_merged_count", 1),
                })
                i += 2
                changed = True
            else:
                out.append(p1)
                i += 1
        peaks = out

    return peaks


def compute_drt(
    frequencies: np.ndarray,
    Z: np.ndarray,
    lambda_reg: float = 1e-3,
    n_tau: int = 100,
    mode: str = 'imag',
) -> DRTResult:
    log_tau, K_im, K_re, L = _build_kernel(frequencies, n_tau)
    gamma, r_inf, inductance = _solve_drt_system(frequencies, Z, K_im, K_re, L, lambda_reg, mode)
    peaks = _fit_gaussian_peaks(log_tau, gamma)
    peaks = _merge_nearby_peaks(log_tau, gamma, peaks)
    return DRTResult(
        log_tau=log_tau.tolist(),
        gamma=gamma.tolist(),
        peaks=peaks,
        mode=mode,
        r_inf=r_inf,
        inductance=inductance,
    )


def _consolidate_by_anchor(peaks: list[dict], anchor_taus: list[float]) -> list[dict]:
    """Merge peaks sharing the same λ×10 anchor; drop λ-unstable artifacts.

    Peaks that all converge to the same position in the more-regularised spectrum are
    the same physical process.  Solo peaks with no higher-λ confirmation are likely
    splitting artifacts of insufficient regularisation.
    """
    if not anchor_taus:
        # λ×10 spectrum is empty (heavily over-regularised data) — skip filtering
        return peaks

    groups: dict[float, list[dict]] = {}
    solo: list[dict] = []
    for p in peaks:
        anchor = p.get("anchor_tau")
        if anchor is not None:
            key = round(float(anchor), 3)
            groups.setdefault(key, []).append(p)
        else:
            solo.append(p)

    out: list[dict] = []

    for key, group in groups.items():
        if len(group) == 1:
            out.append(group[0])
            continue
        total_A = sum(p["amplitude"] for p in group)
        if total_A < 1e-30:
            out.append(max(group, key=lambda p: p["amplitude"]))
            continue
        new_mu = sum(p["amplitude"] * p["log_tau_center"] for p in group) / total_A
        new_tau = float(10.0 ** new_mu)
        span = max(p["log_tau_center"] for p in group) - min(p["log_tau_center"] for p in group)
        new_sigma = max(max(p["sigma"] for p in group), span * 0.5)
        merged_mask = 0
        for p in group:
            merged_mask |= p.get("stability_mask", 0)
        out.append({
            "amplitude":             float(total_A),
            "log_tau_center":        float(new_mu),
            "tau_center":            new_tau,
            "freq_center":           float(1.0 / (2.0 * np.pi * new_tau)),
            "sigma":                 float(new_sigma),
            "r2":                    max(p["r2"] for p in group),
            "stability_mask":        int(merged_mask),
            "stability_count":       bin(merged_mask).count('1'),
            "stable_at_high_lambda": bool(merged_mask & 0b1100),
            "cluster_std":           min(p.get("cluster_std", 999.0) for p in group),
            "re_im_confirmed":       any(p.get("re_im_confirmed", False) for p in group),
            "anchor_tau":            float(key),
            "_merged_count":         sum(p.get("_merged_count", 1) for p in group),
        })

    # Solo peaks (no λ×10 anchor): always keep — dropping them loses real processes.
    # The anchor-based merge handles the "3 humps → 1 peak" case; solo peaks simply
    # didn't map to any λ×10 anchor and should remain visible for manual inspection.
    out.extend(solo)

    return sorted(out, key=lambda p: p["log_tau_center"])


def _enrich_peaks(
    result: DRTResult,
    frequencies: np.ndarray,
    Z: np.ndarray,
    lambda_opt: float,
    mode: str = 'imag',
) -> None:
    """Mutates result.peaks in-place; populates result.lambda_variants.

    Per-peak fields added:
    - freq_center:           characteristic frequency 1/(2π τ)
    - stability_mask:        4-bit int (bit0=λ/100, bit1=λ/10, bit2=λ×10, bit3=λ×100)
    - stability_count:       popcount(stability_mask)
    - stable_at_high_lambda: True if bits 2 or 3 are set (peak survives more regularisation)
    - cluster_std:           std of peak positions across variant spectra (low = stable position)
    - re_im_confirmed:       peak appears in real-part DRT at the same λ
    - anchor_tau:            nearest λ×10 peak used as the convergence anchor

    Then applies _consolidate_by_anchor to merge humps that converge to the same process.
    """
    n_tau = len(result.log_tau)
    log_tau, K_im, K_re, L = _build_kernel(frequencies, n_tau)
    log_tau_arr = np.array(log_tau)

    # λ variants use the same solve mode as the main spectrum so the stability
    # overlay compares like with like.
    variant_mults = [0.01, 0.1, 10.0, 100.0]
    variant_gammas: list[np.ndarray] = []
    for mult in variant_mults:
        g, _, _ = _solve_drt_system(frequencies, Z, K_im, K_re, L, lambda_opt * mult, mode)
        variant_gammas.append(g)

    r_inf = float(Z.real[np.argmax(frequencies)])
    gamma_re = _solve_tikhonov(K_re, L, Z.real - r_inf, lambda_opt)

    MATCH_TOL = 0.45

    def _peak_taus(g: np.ndarray) -> list[float]:
        max_g = g.max()
        if max_g < 1e-30:
            return []
        idxs, _ = find_peaks(g / max_g, height=0.04, prominence=0.02, distance=2)
        return [float(log_tau_arr[i]) for i in idxs]

    variant_tau_lists = [_peak_taus(g) for g in variant_gammas]
    re_taus = _peak_taus(gamma_re)
    anchor_taus = variant_tau_lists[2]  # λ×10 peaks as convergence reference

    for peak in result.peaks:
        mu = peak["log_tau_center"]
        peak["freq_center"] = float(1.0 / (2.0 * np.pi * peak["tau_center"]))

        mask = 0
        found_positions: list[float] = []
        for bit, taus in enumerate(variant_tau_lists):
            matches = [t for t in taus if abs(t - mu) < MATCH_TOL]
            if matches:
                mask |= (1 << bit)
                found_positions.append(min(matches, key=lambda t: abs(t - mu)))

        peak["stability_mask"] = int(mask)
        peak["stability_count"] = bin(mask).count('1')
        peak["stable_at_high_lambda"] = bool(mask & 0b1100)  # λ×10 (bit2) or λ×100 (bit3)

        all_pos = [mu] + found_positions
        peak["cluster_std"] = float(np.std(all_pos)) if len(all_pos) > 1 else 0.0

        if anchor_taus:
            nearest = min(anchor_taus, key=lambda t: abs(t - mu))
            peak["anchor_tau"] = float(nearest) if abs(nearest - mu) < 0.8 else None
        else:
            peak["anchor_tau"] = None

        peak["re_im_confirmed"] = bool(any(abs(t - mu) < MATCH_TOL for t in re_taus))

    result.peaks = _consolidate_by_anchor(result.peaks, anchor_taus)

    result.lambda_variants = [
        {"lambda_val": float(lambda_opt * mult), "gamma": g.tolist()}
        for mult, g in zip(variant_mults, variant_gammas)
    ]


def _sigma_from_fwhm(log_tau: np.ndarray, gamma: np.ndarray, peak_idx: int) -> float:
    """Estimate Gaussian σ from the half-width at half-maximum of the peak."""
    h = gamma[peak_idx]
    if h < 1e-30:
        return 0.3
    half = h * 0.5
    left = peak_idx
    while left > 0 and gamma[left] >= half:
        left -= 1
    right = peak_idx
    while right < len(gamma) - 1 and gamma[right] >= half:
        right += 1
    fwhm = max(log_tau[right] - log_tau[left], log_tau[1] - log_tau[0])
    return float(max(fwhm / 2.355, 0.12))   # σ = FWHM / (2√(2 ln 2))


def _fit_gaussian_peaks(log_tau: np.ndarray, gamma: np.ndarray) -> list[dict]:
    """Sequential (CLEAN-like) single-Gaussian fitting.

    Each iteration: find the dominant peak in the current residual, fit one
    Gaussian against it with TRF solver, subtract, repeat.  This avoids the
    convergence fragility of simultaneous multi-peak fitting and gives better
    results for broad, overlapping, or weakly-defined peaks.
    """
    max_val = gamma.max()
    if max_val < 1e-30:
        return []

    MIN_SIGMA = 0.12   # narrower than one log-decade grid step → likely artefact
    MAX_PEAKS = 8
    residual  = gamma.copy()
    results   = []

    def gauss(x, A, mu, sig):
        return A * np.exp(-0.5 * ((x - mu) / (sig + 1e-12)) ** 2)

    for _ in range(MAX_PEAKS):
        peak_indices, _ = find_peaks(
            residual / max_val,
            height=0.04,
            prominence=0.02,
            distance=2,
        )
        if not len(peak_indices):
            break

        # Fit against the residual peak with the highest amplitude
        best   = peak_indices[int(np.argmax(residual[peak_indices]))]
        amp0   = float(residual[best])
        mu0    = float(log_tau[best])
        sig0   = _sigma_from_fwhm(log_tau, residual, best)

        try:
            popt, _ = curve_fit(
                gauss, log_tau, residual,
                p0=[amp0, mu0, sig0],
                bounds=([0.0, float(log_tau[0]),  MIN_SIGMA],
                        [np.inf, float(log_tau[-1]), 5.0]),
                maxfev=3000,
                method='trf',
            )
            A, mu, sig = popt
        except Exception:
            A, mu, sig = amp0, mu0, sig0

        fitted = gauss(log_tau, A, mu, sig)

        # Shape-match score (1 − RMSE/peak height) within ±1.5σ — a 0–1 goodness
        # heuristic for how Gaussian the peak is, NOT a statistical R².  The field
        # is named "r2" for backwards compatibility with cached results.
        window = np.abs(log_tau - mu) <= 1.5 * max(sig, 0.1)
        if window.sum() >= 3:
            peak_h = float(residual[window].max())
            rmse   = float(np.sqrt(np.mean((residual[window] - fitted[window]) ** 2)))
            r2     = max(0.0, min(1.0, 1.0 - rmse / (peak_h + 1e-30)))
        else:
            r2 = 0.0

        results.append({
            "amplitude":      float(A),
            "log_tau_center": float(mu),
            "tau_center":     float(10.0 ** mu),
            "sigma":          float(sig),
            "r2":             r2,
        })

        residual = np.maximum(residual - fitted, 0.0)

        # Stop when remaining residual is negligible
        if residual.max() / max_val < 0.04:
            break

    results.sort(key=lambda p: p["log_tau_center"])
    return results


async def compute_drt_for_file(request: DRTSingleRequest) -> DRTResult:
    try:
        frequencies, Z, char_values = await asyncio.to_thread(
            load_eis_data, request.file.path, request.column_map
        )
        result = await asyncio.to_thread(
            compute_drt, frequencies, Z, request.lambda_reg, 100, request.mode
        )
        await asyncio.to_thread(_enrich_peaks, result, frequencies, Z, request.lambda_reg, request.mode)
        result.filename = request.file.filename
        result.path     = request.file.path
        result.success  = True
        allowed_keys = set(request.column_map.characterization.keys()) | {'identifier', 'battery_id'}
        result.characterization = {k: v for k, v in char_values.items() if k in allowed_keys}
    except Exception as exc:
        result = DRTResult(filename=request.file.filename, path=request.file.path,
                           success=False, error=str(exc))
    return result


def compute_lcurve_data(
    frequencies: np.ndarray,
    Z: np.ndarray,
    n_lambda: int = 30,
    lambda_min: float = 1e-7,
    lambda_max: float = 10.0,
    mode: str = 'imag',
):
    """Compute L-curve: residual norm vs solution norm across λ values.
    Returns dict with points, optimal_lambda, optimal_index.
    Corner is detected via the triangle method in normalised log-log space."""
    _, K_im, K_re, L = _build_kernel(frequencies)
    omega = 2 * np.pi * frequencies

    lambdas = np.logspace(np.log10(lambda_min), np.log10(lambda_max), n_lambda)

    points = []
    for lam in lambdas:
        gamma, r_inf, induct = _solve_drt_system(frequencies, Z, K_im, K_re, L, lam, mode)
        if mode == 'complex':
            res_re = (r_inf + K_re @ gamma) - Z.real
            res_im = (K_im @ gamma - omega * induct) - (-Z.imag)
            residual = float(np.sqrt(np.sum(res_re ** 2) + np.sum(res_im ** 2)))
        else:
            residual = float(np.linalg.norm(K_im @ gamma - (-Z.imag)))
        points.append({
            "lambda_val":    float(lam),
            "residual_norm": residual,
            "solution_norm": float(np.linalg.norm(L @ gamma)),
        })

    # Corner detection: triangle method — the point of maximum perpendicular
    # distance from the chord connecting the L-curve endpoints in normalised
    # log-log space.  With a true non-negative Tikhonov solver the residual norm
    # grows monotonically with λ, so the knee of the residual/smoothness
    # trade-off is the geometric corner.
    log_rn = np.log10(np.maximum([p["residual_norm"] for p in points], 1e-30))
    log_sn = np.log10(np.maximum([p["solution_norm"] for p in points], 1e-30))
    rn_n = (log_rn - log_rn.min()) / (log_rn.max() - log_rn.min() + 1e-30)
    sn_n = (log_sn - log_sn.min()) / (log_sn.max() - log_sn.min() + 1e-30)
    dx = rn_n[-1] - rn_n[0]
    dy = sn_n[-1] - sn_n[0]
    dist = np.abs(dy * (rn_n - rn_n[0]) - dx * (sn_n - sn_n[0])) / (np.sqrt(dx**2 + dy**2) + 1e-30)
    corner_idx = int(np.argmax(dist))

    return {
        "points":         points,
        "optimal_lambda": float(lambdas[corner_idx]),
        "optimal_index":  corner_idx,
    }


async def compute_drt_auto_for_file(file_info, column_map, mode: str = 'imag') -> dict:
    """Load data once, find optimal λ via L-curve, compute DRT at that λ."""
    try:
        frequencies, Z, char_values = await asyncio.to_thread(
            load_eis_data, file_info.path, column_map
        )
        lcurve = await asyncio.to_thread(compute_lcurve_data, frequencies, Z, 30, 1e-7, 10.0, mode)
        optimal_lambda = lcurve["optimal_lambda"]

        result = await asyncio.to_thread(compute_drt, frequencies, Z, optimal_lambda, 100, mode)
        await asyncio.to_thread(_enrich_peaks, result, frequencies, Z, optimal_lambda, mode)
        result.filename   = file_info.filename
        result.path       = file_info.path
        result.success    = True
        result.lambda_used = float(optimal_lambda)
        allowed_keys = set(column_map.characterization.keys()) | {"identifier", "battery_id"}
        result.characterization = {k: v for k, v in char_values.items() if k in allowed_keys}
        return result.model_dump()
    except Exception as exc:
        return {
            "filename": file_info.filename,
            "success": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "lambda_used": None,
        }


async def compute_lcurve_for_file(request: LCurveRequest) -> dict:
    try:
        frequencies, Z, _ = await asyncio.to_thread(
            load_eis_data, request.file.path, request.column_map
        )
        result = await asyncio.to_thread(
            compute_lcurve_data, frequencies, Z, 30, 1e-7, 10.0, request.mode
        )
        return {"success": True, **result}
    except Exception as exc:
        tb = traceback.format_exc()
        return {"success": False, "error": str(exc), "traceback": tb}


async def drt_batch_stream(request: DRTRequest) -> AsyncGenerator[str, None]:
    total = len(request.files)

    for i, file_info in enumerate(request.files):
        yield f"data: {json.dumps({'event': 'progress', 'file': file_info.filename, 'index': i, 'total': total})}\n\n"

        try:
            frequencies, Z, char_values = await asyncio.to_thread(
                load_eis_data, file_info.path, request.column_map
            )
            result = await asyncio.to_thread(
                compute_drt, frequencies, Z, request.lambda_reg, 100, request.mode
            )
            result.filename = file_info.filename
            result.path     = file_info.path
            result.success  = True
            # Only include mapped characterization + special fields (identifier, battery_id)
            allowed_keys = set(request.column_map.characterization.keys()) | {'identifier', 'battery_id'}
            result.characterization = {k: v for k, v in char_values.items() if k in allowed_keys}
        except Exception as exc:
            result = DRTResult(filename=file_info.filename, success=False, error=str(exc))

        yield f"data: {json.dumps({'event': 'result', 'data': result.model_dump()})}\n\n"

    yield f"data: {json.dumps({'event': 'done'})}\n\n"
