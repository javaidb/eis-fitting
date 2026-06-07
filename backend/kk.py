from __future__ import annotations
import asyncio
import json
from typing import AsyncGenerator, Optional

import numpy as np
from impedance import validation as _imp_validation
from impedance.validation import linKK

# Workaround for a bug in this version of impedance.py: eval_linKK calls
# eval(circuit_string, circuit_elements) but numpy is not in that namespace,
# causing NameError when any element function references np internally.
_imp_validation.circuit_elements.setdefault('np', np)

from .file_handler import load_eis_data
from .models import KKRequest, KKResult


def _interp_zero(x0: float, y0: float, x1: float, y1: float) -> float:
    """Linear interpolation: x where y=0 between two points."""
    dy = y1 - y0
    return x0 if abs(dy) < 1e-30 else float(x0 - y0 * (x1 - x0) / dy)


def _lf_intercept_from_circle(zr: np.ndarray, yi: np.ndarray) -> float | None:
    """Fit a circle to the capacitive arc and extrapolate the right-side real-axis intercept.

    Arc selection (HF→LF order):
    • Ascending side (HF to peak): all points with −Z'' > 0.
    • Descending side (peak to LF): points where −Z'' > 15 % of peak value.
      This threshold excludes Warburg/diffusion tail contamination.

    Returns None if fewer than 3 arc points are found, the algebraic fit is degenerate,
    or the fitted circle does not intersect the real axis.
    """
    n = len(yi)
    if n < 3:
        return None

    peak_idx = int(np.argmax(yi))
    peak_val = float(yi[peak_idx])
    if peak_val <= 0:
        return None

    # Build the arc point mask.
    include = np.zeros(n, dtype=bool)
    for i in range(n):
        if i <= peak_idx:
            # Ascending side: include only positive −Z'' (skip inductive HF points).
            if yi[i] > 0:
                include[i] = True
        else:
            # Descending side: stop as soon as we drop below 15 % of peak or hit zero.
            if yi[i] <= 0 or yi[i] < 0.15 * peak_val:
                break
            include[i] = True

    if include.sum() < 3:
        return None

    x, y = zr[include], yi[include]

    # Algebraic circle fit: x² + y² + Dx + Ey + F = 0
    # → centre (−D/2, −E/2), radius = √(D²/4 + E²/4 − F)
    A = np.column_stack([x, y, np.ones_like(x)])
    b_vec = -(x ** 2 + y ** 2)
    try:
        params, _, rank, _ = np.linalg.lstsq(A, b_vec, rcond=None)
        if rank < 3:
            return None
    except Exception:
        return None

    D, E, F = params
    cx = -D / 2.0
    cy = -E / 2.0
    r_sq = cx ** 2 + cy ** 2 - F

    if r_sq <= 0:
        return None

    # Real-axis intersection: (x − cx)² + cy² = r²
    disc = r_sq - cy ** 2
    if disc < 0:
        return None  # circle doesn't reach the real axis

    lf_x = float(cx + np.sqrt(disc))  # right-side intersection

    # Sanity: must be positive and not absurdly large relative to arc extent.
    if lf_x < 0 or lf_x > float(np.max(x)) * 20:
        return None

    return lf_x


def _find_nyquist_intercepts(
    frequencies: np.ndarray, Z: np.ndarray
) -> tuple[float, float | None]:
    """Find HF and LF real-axis intercepts of a Nyquist curve.

    • HF intercept: linear interpolation to the first upward zero-crossing of −Z''
      (inductive → capacitive transition). Falls back to the highest-frequency point.
    • LF intercept: circle fit to the capacitive arc + extrapolation to y = 0.
      Returns None when no identifiable semicircle is found.
    """
    sort_idx = np.argsort(frequencies)[::-1]   # HF first
    zr = Z.real[sort_idx]
    yi = -Z.imag[sort_idx]                     # −Z'' > 0 for capacitive arcs
    n = len(yi)

    # ── HF intercept: scan for first upward zero-crossing ───────────────────────
    hf_intercept = float(zr[0])
    for i in range(n - 1):
        if yi[i] <= 0 < yi[i + 1]:
            hf_intercept = _interp_zero(zr[i], yi[i], zr[i + 1], yi[i + 1])
            break
        if yi[i] > 0:
            # Data already starts in the capacitive region — use the first point.
            break

    # ── LF intercept: circle fitting on the arc ──────────────────────────────────
    lf_intercept = _lf_intercept_from_circle(zr, yi)

    return hf_intercept, lf_intercept


def run_kk_single(
    frequencies: np.ndarray,
    Z: np.ndarray,
    c: float = 0.85,
    max_M: int = 50,
    residual_threshold: float = 0.01,
) -> KKResult:
    """Run Lin-KK compliance test on one EIS spectrum.

    Returns normalised residuals (divided by |Z_fit|) and flags frequency points
    where the absolute residual exceeds `residual_threshold`.
    """
    M, mu, Z_kk, res_real, res_imag = linKK(
        frequencies, Z, c=c, max_M=max_M, fit_type='complex'
    )

    residual_mag = np.sqrt(res_real ** 2 + res_imag ** 2)
    flagged = list(map(int, np.where(residual_mag > residual_threshold)[0]))

    # Suggest freq range as the contiguous band of compliant points.
    valid = residual_mag <= residual_threshold
    freq_min_s: Optional[float] = None
    freq_max_s: Optional[float] = None
    if valid.any():
        valid_freqs = frequencies[valid]
        freq_min_s = float(valid_freqs.min())
        freq_max_s = float(valid_freqs.max())

    # Interpolated real-axis intercepts (more accurate than raw endpoint Z').
    hf_intercept, lf_intercept = _find_nyquist_intercepts(frequencies, Z)

    return KKResult(
        success=True,
        M=int(M),
        mu=float(mu),
        frequencies=frequencies.tolist(),
        z_real=Z.real.tolist(),
        z_imag=Z.imag.tolist(),
        res_real=res_real.tolist(),
        res_imag=res_imag.tolist(),
        residual_magnitude=residual_mag.tolist(),
        flagged_indices=flagged,
        freq_min_suggest=freq_min_s,
        freq_max_suggest=freq_max_s,
        rs_estimate=hf_intercept,
        lf_intercept=lf_intercept,
    )


async def kk_batch_stream(request: KKRequest) -> AsyncGenerator[str, None]:
    total = len(request.files)

    for i, file_info in enumerate(request.files):
        yield f"data: {json.dumps({'event': 'progress', 'file': file_info.filename, 'index': i, 'total': total})}\n\n"

        try:
            frequencies, Z, _ = await asyncio.to_thread(
                load_eis_data, file_info.path, request.column_map
            )

            mask = np.ones(len(frequencies), dtype=bool)
            if request.freq_min is not None:
                mask &= frequencies >= request.freq_min
            if request.freq_max is not None:
                mask &= frequencies <= request.freq_max
            if not mask.all():
                frequencies = frequencies[mask]
                Z = Z[mask]

            result = await asyncio.to_thread(
                run_kk_single,
                frequencies, Z,
                request.c, request.max_M, request.residual_threshold,
            )
            result.filename = file_info.filename
            result.path = file_info.path

        except Exception as exc:
            result = KKResult(
                filename=file_info.filename,
                path=file_info.path,
                success=False,
                error=str(exc),
            )

        yield f"data: {json.dumps({'event': 'result', 'data': result.model_dump()})}\n\n"

    yield f"data: {json.dumps({'event': 'done'})}\n\n"
