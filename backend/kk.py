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
