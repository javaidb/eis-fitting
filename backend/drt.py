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


def compute_drt(
    frequencies: np.ndarray,
    Z: np.ndarray,
    lambda_reg: float = 1e-3,
    n_tau: int = 100,
) -> DRTResult:
    omega = 2 * np.pi * frequencies
    z_imag = -Z.imag  # positive for capacitive arcs

    # Log-τ grid spanning one decade beyond the data range
    log_tau_min = np.log10(1.0 / omega.max()) - 1.0
    log_tau_max = np.log10(1.0 / omega.min()) + 1.0
    log_tau = np.linspace(log_tau_min, log_tau_max, n_tau)
    tau = 10.0 ** log_tau
    d_log10 = log_tau[1] - log_tau[0]

    # Kernel matrix: K_kj = (ω_k τ_j)/(1+(ω_k τ_j)²) · ln10 · Δ(log₁₀τ)
    wt = omega[:, None] * tau[None, :]
    K = wt / (1.0 + wt ** 2) * np.log(10) * d_log10

    # Second-derivative Tikhonov regularization matrix
    L = np.zeros((n_tau - 2, n_tau))
    idx = np.arange(n_tau - 2)
    L[idx, idx] = 1.0
    L[idx, idx + 1] = -2.0
    L[idx, idx + 2] = 1.0

    # Solve (K^T K + λ L^T L) γ = K^T z_imag
    A = K.T @ K + lambda_reg * (L.T @ L)
    b = K.T @ z_imag
    gamma = np.linalg.solve(A, b)
    gamma = np.maximum(gamma, 0.0)

    peaks = _fit_gaussian_peaks(log_tau, gamma)

    return DRTResult(
        log_tau=log_tau.tolist(),
        gamma=gamma.tolist(),
        peaks=peaks,
    )


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
