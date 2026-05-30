from __future__ import annotations
import asyncio
import json
from typing import AsyncGenerator

import numpy as np
from scipy.optimize import curve_fit
from scipy.signal import find_peaks

from .file_handler import load_eis_data
from .models import DRTRequest, DRTResult


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


def _fit_gaussian_peaks(log_tau: np.ndarray, gamma: np.ndarray) -> list[dict]:
    max_val = gamma.max()
    if max_val < 1e-30:
        return []

    gamma_norm = gamma / max_val
    peak_indices, _ = find_peaks(
        gamma_norm,
        height=0.05,
        prominence=0.03,
        distance=3,
    )
    if len(peak_indices) == 0:
        return []

    n = len(peak_indices)

    def model(x, *params):
        y = np.zeros_like(x, dtype=float)
        for i in range(n):
            A, mu, sigma = params[3 * i], params[3 * i + 1], params[3 * i + 2]
            y += A * np.exp(-0.5 * ((x - mu) / (sigma + 1e-12)) ** 2)
        return y

    p0, lo, hi = [], [], []
    for idx in peak_indices:
        p0 += [gamma[idx], log_tau[idx], 0.3]
        lo += [0.0, float(log_tau[0]), 0.01]
        hi += [np.inf, float(log_tau[-1]), 5.0]

    try:
        popt, _ = curve_fit(model, log_tau, gamma, p0=p0, bounds=(lo, hi), maxfev=5000)
    except Exception:
        popt = p0

    # Pre-compute each Gaussian curve
    gaussians = []
    for i in range(n):
        A, mu, sigma = popt[3 * i], popt[3 * i + 1], popt[3 * i + 2]
        gaussians.append(A * np.exp(-0.5 * ((log_tau - mu) / (sigma + 1e-12)) ** 2))

    results = []
    for i in range(n):
        A, mu, sigma = popt[3 * i], popt[3 * i + 1], popt[3 * i + 2]

        # Peak quality: RMSE within ±1.5σ normalized by the actual DRT peak
        # height in that window (not the fitted amplitude).  This directly
        # penalises a Gaussian that is too short or too broad to reach the data.
        window = np.abs(log_tau - mu) <= 1.5 * max(sigma, 0.05)
        if window.sum() >= 3:
            others = sum(gaussians[j] for j in range(n) if j != i)
            gamma_local = gamma[window] - others[window]
            g_local = gaussians[i][window]
            peak_actual = float(gamma_local.max())
            rmse = float(np.sqrt(np.mean((gamma_local - g_local) ** 2)))
            r2 = max(0.0, min(1.0, 1.0 - rmse / (peak_actual + 1e-30)))
        else:
            r2 = 0.0

        results.append({
            "amplitude": float(A),
            "log_tau_center": float(mu),
            "tau_center": float(10.0 ** mu),
            "sigma": float(sigma),
            "r2": r2,
        })
    return results


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
            result.success = True
            result.characterization = char_values
        except Exception as exc:
            result = DRTResult(filename=file_info.filename, success=False, error=str(exc))

        yield f"data: {json.dumps({'event': 'result', 'data': result.model_dump()})}\n\n"

    yield f"data: {json.dumps({'event': 'done'})}\n\n"
