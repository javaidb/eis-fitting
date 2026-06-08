from __future__ import annotations
import asyncio
import json
import traceback
from typing import AsyncGenerator

import numpy as np
from scipy.optimize import curve_fit
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
    A = K.T @ K + lambda_reg * (L.T @ L)
    return np.maximum(np.linalg.solve(A, K.T @ rhs), 0.0)


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
) -> DRTResult:
    log_tau, K_im, _, L = _build_kernel(frequencies, n_tau)
    gamma = _solve_tikhonov(K_im, L, -Z.imag, lambda_reg)
    peaks = _fit_gaussian_peaks(log_tau, gamma)
    peaks = _merge_nearby_peaks(log_tau, gamma, peaks)
    return DRTResult(
        log_tau=log_tau.tolist(),
        gamma=gamma.tolist(),
        peaks=peaks,
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


def _enrich_peaks(result: DRTResult, frequencies: np.ndarray, Z: np.ndarray, lambda_opt: float) -> None:
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
    z_imag = -Z.imag

    variant_mults = [0.01, 0.1, 10.0, 100.0]
    variant_gammas: list[np.ndarray] = []
    for mult in variant_mults:
        variant_gammas.append(_solve_tikhonov(K_im, L, z_imag, lambda_opt * mult))

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

        # R²: compare fitted Gaussian to the residual within ±1.5σ
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
            compute_drt, frequencies, Z, request.lambda_reg
        )
        await asyncio.to_thread(_enrich_peaks, result, frequencies, Z, request.lambda_reg)
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
):
    """Compute L-curve: residual norm vs solution norm across λ values.
    Returns dict with points, optimal_lambda, optimal_index.
    Corner is detected via maximum curvature in log-log space."""
    omega = 2 * np.pi * frequencies
    z_imag = -Z.imag

    n_tau = 100
    log_tau_min = np.log10(1.0 / omega.max()) - 1.0
    log_tau_max = np.log10(1.0 / omega.min()) + 1.0
    log_tau = np.linspace(log_tau_min, log_tau_max, n_tau)
    tau = 10.0 ** log_tau
    d_log10 = log_tau[1] - log_tau[0]

    wt = omega[:, None] * tau[None, :]
    K = wt / (1.0 + wt ** 2) * np.log(10) * d_log10

    L = np.zeros((n_tau - 2, n_tau))
    idx = np.arange(n_tau - 2)
    L[idx, idx]     =  1.0
    L[idx, idx + 1] = -2.0
    L[idx, idx + 2] =  1.0

    lambdas = np.logspace(np.log10(lambda_min), np.log10(lambda_max), n_lambda)

    points = []
    for lam in lambdas:
        A = K.T @ K + lam * (L.T @ L)
        b = K.T @ z_imag
        gamma = np.maximum(np.linalg.solve(A, b), 0.0)
        points.append({
            "lambda_val":    float(lam),
            "residual_norm": float(np.linalg.norm(K @ gamma - z_imag)),
            "solution_norm": float(np.linalg.norm(L @ gamma)),
        })

    # Corner detection: minimum of residual norm.
    #
    # With a positivity-constrained DRT (gamma >= 0), the residual norm is NOT
    # monotone in lambda.  At very low lambda the unconstrained solution has large
    # negative lobes that are clipped to zero, wrecking the fit; at very high
    # lambda over-smoothing also degrades the fit.  The minimum residual norm
    # therefore identifies the lambda at which the non-negativity constraint first
    # "costs" nothing — the geometric corner of this constrained L-curve.
    #
    # Fallback: if the minimum is at a boundary (lambda range too narrow), use
    # the triangle method (max perpendicular distance from the chord in normalised
    # log-log space) which is the most robust purely geometric criterion.
    residual_norms = np.array([p["residual_norm"] for p in points])
    corner_idx = int(np.argmin(residual_norms))

    if corner_idx <= 1 or corner_idx >= n_lambda - 2:
        # Fallback: geometric triangle method
        log_rn = np.log10(residual_norms)
        log_sn = np.log10(np.array([p["solution_norm"] for p in points]))
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


async def compute_drt_auto_for_file(file_info, column_map) -> dict:
    """Load data once, find optimal λ via L-curve, compute DRT at that λ."""
    try:
        frequencies, Z, char_values = await asyncio.to_thread(
            load_eis_data, file_info.path, column_map
        )
        lcurve = await asyncio.to_thread(compute_lcurve_data, frequencies, Z)
        optimal_lambda = lcurve["optimal_lambda"]

        result = await asyncio.to_thread(compute_drt, frequencies, Z, optimal_lambda)
        await asyncio.to_thread(_enrich_peaks, result, frequencies, Z, optimal_lambda)
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
        result = await asyncio.to_thread(compute_lcurve_data, frequencies, Z)
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
                compute_drt, frequencies, Z, request.lambda_reg
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
