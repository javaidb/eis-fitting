from __future__ import annotations
import asyncio
import json
import re
from typing import AsyncGenerator, Dict

import numpy as np
from impedance.models.circuits import CustomCircuit

from .file_handler import load_eis_data
from .models import CircuitConfig, FitRequest, FitResult

_TWO_PARAM = {"CPE", "Wo", "Ws", "La"}


def count_circuit_params(circuit_string: str) -> int:
    tokens = re.findall(r"([A-Za-z]+)\d+", circuit_string)
    return sum(2 if t in _TWO_PARAM else 1 for t in tokens)


def get_param_names(circuit_string: str) -> tuple[list[str], list[str]]:
    n = count_circuit_params(circuit_string)
    circuit = CustomCircuit(circuit=circuit_string, initial_guess=[1.0] * n)
    names, units = circuit.get_param_names()
    return list(names), list(units)


def fit_single(
    frequencies: np.ndarray,
    Z: np.ndarray,
    circuit_config: CircuitConfig,
    char_values: Dict[str, float],
    filename: str,
) -> FitResult:
    lower = [b if b is not None else 0.0 for b in circuit_config.lower_bounds]
    upper = [b if b is not None else np.inf for b in circuit_config.upper_bounds]

    try:
        circuit = CustomCircuit(
            circuit=circuit_config.circuit_string,
            initial_guess=circuit_config.initial_guess,
        )
        circuit.fit(frequencies, Z, bounds=(lower, upper))

        Z_fit = circuit.predict(frequencies)
        params = dict(zip(circuit_config.param_names, circuit.parameters_.tolist()))

        conf: Dict[str, float] = {}
        if circuit.conf_ is not None:
            conf = dict(zip(circuit_config.param_names, circuit.conf_.tolist()))

        residual = float(np.mean(np.abs(Z - Z_fit) / (np.abs(Z) + 1e-12)))

        return FitResult(
            filename=filename,
            success=True,
            parameters=params,
            confidence=conf,
            frequencies=frequencies.tolist(),
            z_real_fit=Z_fit.real.tolist(),
            z_imag_fit=Z_fit.imag.tolist(),
            z_real_data=Z.real.tolist(),
            z_imag_data=Z.imag.tolist(),
            characterization=char_values,
            residual=residual,
        )
    except Exception as exc:
        return FitResult(
            filename=filename,
            success=False,
            error=str(exc),
            frequencies=frequencies.tolist(),
            z_real_data=Z.real.tolist(),
            z_imag_data=Z.imag.tolist(),
            characterization=char_values,
        )


async def fit_batch_stream(request: FitRequest) -> AsyncGenerator[str, None]:
    total = len(request.files)

    for i, file_info in enumerate(request.files):
        yield f"data: {json.dumps({'event': 'progress', 'file': file_info.filename, 'index': i, 'total': total})}\n\n"

        try:
            frequencies, Z, char_values = await asyncio.to_thread(
                load_eis_data, file_info.path, request.column_map
            )
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    fit_single, frequencies, Z, request.circuit_config, char_values, file_info.filename
                ),
                timeout=request.fit_timeout,
            )
        except asyncio.TimeoutError:
            result = FitResult(filename=file_info.filename, success=False, error=f"Fit timed out after {request.fit_timeout:g} s")
        except Exception as exc:
            result = FitResult(filename=file_info.filename, success=False, error=str(exc))

        yield f"data: {json.dumps({'event': 'result', 'data': result.model_dump()})}\n\n"

    yield f"data: {json.dumps({'event': 'done'})}\n\n"
