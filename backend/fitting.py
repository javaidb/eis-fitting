from __future__ import annotations
import asyncio
import json
import re
from typing import AsyncGenerator, Dict, List, Optional, Union

import numpy as np
from numpy.random import default_rng
from scipy.optimize import curve_fit, differential_evolution as _diff_ev, basinhopping, minimize
from impedance.models.circuits import CustomCircuit

from .file_handler import load_eis_data
from .models import CircuitConfig, ColumnMap, FitRequest, FitResult, OptimizeConfig, VariantResult

_TWO_PARAM = {"CPE", "Wo", "Ws", "La"}

# Default (initial, lower, upper) per parameter type key.
# Type key is element-name + suffix, e.g. "R", "CPE_0", "CPE_1", "Wo_1".
_PARAM_DEFAULTS: Dict[str, tuple[float, float, float]] = {
    'R':     (0.01,  0.0, float('inf')),
    'C':     (1e-5,  0.0, float('inf')),
    'L':     (1e-6,  0.0, float('inf')),
    'CPE_0': (1e-5,  0.0, float('inf')),
    'CPE_1': (0.8,   0.0, 1.0),
    'W':     (1.0,   0.0, float('inf')),
    'Wo_0':  (0.01,  0.0, float('inf')),
    'Wo_1':  (1.0,   0.0, float('inf')),
    'Wo_2':  (0.5,   0.0, 1.0),
    'Ws_0':  (0.01,  0.0, float('inf')),
    'Ws_1':  (1.0,   0.0, float('inf')),
    'Ws_2':  (0.5,   0.0, 1.0),
    'La_0':  (1e-6,  0.0, float('inf')),
    'La_1':  (0.01,  0.0, float('inf')),
}

# Matches 2-element RC-pair parallel blocks: p(R<n>,CPE<n>) or p(R<n>,C<n>)
_PAIR_RE = re.compile(r'p\(R\d+,(?:CPE|C)\d+\)')


def count_circuit_params(circuit_string: str) -> int:
    tokens = re.findall(r"([A-Za-z]+)\d+", circuit_string)
    return sum(2 if t in _TWO_PARAM else 1 for t in tokens)


def get_param_names(circuit_string: str) -> tuple[list[str], list[str]]:
    n = count_circuit_params(circuit_string)
    circuit = CustomCircuit(circuit=circuit_string, initial_guess=[1.0] * n)
    names, units = circuit.get_param_names()
    return list(names), list(units)


def _param_type_key(name: str) -> str:
    """'CPE1_0' → 'CPE_0', 'R2' → 'R', 'Wo0_1' → 'Wo_1'."""
    m = re.match(r'^([A-Za-z]+)\d+(_\d+)?$', name)
    if not m:
        return name
    return m.group(1) + (m.group(2) or '')


def _build_param_lookup(
    circuit_config: CircuitConfig,
) -> Dict[str, tuple[float, float, float]]:
    """Build name → (initial, lower, upper) from user-configured circuit."""
    lookup: Dict[str, tuple[float, float, float]] = {}
    for i, name in enumerate(circuit_config.param_names):
        initial = circuit_config.initial_guess[i] if i < len(circuit_config.initial_guess) else 1.0
        lower   = circuit_config.lower_bounds[i]  if i < len(circuit_config.lower_bounds)  else None
        upper   = circuit_config.upper_bounds[i]  if i < len(circuit_config.upper_bounds)  else None
        lookup[name] = (
            initial,
            lower if lower is not None else 0.0,
            upper if upper is not None else float('inf'),
        )
    return lookup


def _resolve_bounds(
    param_names: List[str],
    name_lookup: Dict[str, tuple[float, float, float]],
    rs_estimate: float | None = None,
) -> tuple[List[float], List[float], List[float]]:
    """Resolve initial/lower/upper for each param: user lookup first, then type defaults.

    If rs_estimate is given, it overrides the initial guess for R0 (the series
    resistance) so each spectrum's fit starts from the HF real-axis intercept.
    """
    initials, lowers, uppers = [], [], []
    for name in param_names:
        if name in name_lookup:
            i, l, u = name_lookup[name]
        else:
            key = _param_type_key(name)
            i, l, u = _PARAM_DEFAULTS.get(key, (1.0, 0.0, float('inf')))
        # Use KK-derived HF intercept as initial guess for R0 (series resistance)
        if rs_estimate is not None and rs_estimate > 0 and name == 'R0':
            i = float(np.clip(rs_estimate, l, u if np.isfinite(u) else rs_estimate * 100))
        initials.append(i)
        lowers.append(l)
        uppers.append(u)
    return initials, lowers, uppers


def _strip_rc_pairs(circuit_string: str) -> str:
    """Remove all p(R,CPE) and p(R,C) pair blocks (with surrounding dashes)."""
    result = circuit_string
    prev = None
    while result != prev:
        prev = result
        result = re.sub(r'-' + _PAIR_RE.pattern, '', result)   # trailing pair: X-p(...)
        result = re.sub(_PAIR_RE.pattern + r'-', '', result)   # leading pair:  p(...)-X
        result = re.sub(r'^' + _PAIR_RE.pattern + r'$', '', result)  # sole element
    return result


def generate_circuit_variant(
    circuit_string: str,
    target_rc_count: int,
    pair_type: str = "CPE",
) -> str | None:
    """Generate circuit variant with `target_rc_count` RC pairs of `pair_type`.

    Strips existing RC pairs from the circuit string, then inserts the requested
    number of new pairs before any Warburg element (or at the end).  Uses the
    same numeric index for both R and the pair element so that name-based bounds
    lookup re-uses user-configured values for matching pairs.
    """
    frame = _strip_rc_pairs(circuit_string)
    if not frame:
        return None

    if target_rc_count == 0:
        return frame

    r_indices_in_frame = [int(m) for m in re.findall(r'R(\d+)', frame)]
    max_r = max(r_indices_in_frame) if r_indices_in_frame else -1

    pairs = [f"-p(R{max_r + 1 + i},{pair_type}{max_r + 1 + i})" for i in range(target_rc_count)]

    warburg_match = re.search(r'-(?:Wo|Ws|W)\d+$', frame)
    if warburg_match:
        pos = warburg_match.start()
        return frame[:pos] + ''.join(pairs) + frame[pos:]
    return frame + ''.join(pairs)


def _sample_initial_guess(
    initials: List[float],
    lowers: List[float],
    uppers: List[float],
    rng: np.random.Generator,
) -> List[float]:
    """Log-uniform sample within [lower, upper] for each parameter."""
    guess = []
    for i0, lo, hi in zip(initials, lowers, uppers):
        if lo == hi:
            guess.append(lo)
            continue
        lo_pos = max(lo, 1e-30)
        if np.isinf(hi):
            center = max(i0, lo_pos)
            factor = 10 ** rng.uniform(-1, 1)
            guess.append(float(np.clip(center * factor, lo_pos, None)))
        else:
            log_lo = np.log10(max(lo_pos, hi * 1e-10))
            log_hi = np.log10(max(hi, lo_pos * 10))
            guess.append(float(10 ** rng.uniform(log_lo, log_hi)))
    return guess


def _compute_aic_bic(Z: np.ndarray, Z_fit: np.ndarray, k: int) -> tuple[float, float]:
    """AIC and BIC for complex-impedance regression (real+imag as separate observations)."""
    n = 2 * len(Z)
    rss = float(np.sum((Z.real - Z_fit.real) ** 2 + (Z.imag - Z_fit.imag) ** 2))
    if rss <= 0 or n <= 0:
        return float('-inf'), float('-inf')
    ll = n * np.log(rss / n)
    return float(ll + 2 * k), float(ll + k * np.log(n))


# ── weighting helpers ─────────────────────────────────────────────────────────

def _compute_sigma(Z: np.ndarray, weighting: str) -> np.ndarray | None:
    """Return the sigma array for scipy curve_fit, or None for unit (unweighted) fitting.

    'none'         — unit weighting (σ=None, all observations equally weighted)
    'modulus'      — σ_i = |Z_i| for both real and imag (1/|Z|² effective weight)
    'proportional' — σ_r = |Z'_i|, σ_i = |Z''_i| separately; floored to avoid
                     division by zero near the real-axis crossing
    """
    if weighting == 'modulus':
        mod = np.maximum(np.abs(Z), 1e-30)
        return np.concatenate([mod, mod])
    if weighting == 'proportional':
        # Floor imaginary sigma at 1% of the real part to avoid instability near Z''≈0
        sr = np.maximum(np.abs(Z.real), 1e-30)
        si = np.maximum(np.abs(Z.imag), np.abs(Z.real) * 0.01 + 1e-30)
        return np.concatenate([sr, si])
    return None  # 'none' → unweighted


# ── scipy-based fitting primitives ───────────────────────────────────────────

def _make_model_func(circuit_string: str, frequencies: np.ndarray):
    """Return a scipy-compatible model function and a fresh CustomCircuit instance."""
    n_params = count_circuit_params(circuit_string)
    c = CustomCircuit(circuit=circuit_string, initial_guess=[1.0] * n_params)
    x_dummy = np.zeros(2 * len(frequencies))

    def model_func(x, *params):
        c.parameters_ = np.array(params)
        Z_pred = c.predict(frequencies)
        return np.concatenate([Z_pred.real, Z_pred.imag])

    return model_func, c, x_dummy


def _do_lm_fit(
    circuit_string: str,
    initials: List[float],
    lowers: List[float],
    uppers: List[float],
    frequencies: np.ndarray,
    Z: np.ndarray,
    weighting: str = 'none',
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray]:
    """Fit circuit via scipy TRF (bounded LM). Returns (popt, pcov, Z_fit).

    pcov is the full parameter covariance matrix; its diagonal gives 1σ errors.
    """
    model_func, c, x_dummy = _make_model_func(circuit_string, frequencies)
    Z_target = np.concatenate([Z.real, Z.imag])
    sigma = _compute_sigma(Z, weighting)
    uppers_safe = [float('inf') if np.isinf(u) else u for u in uppers]

    popt, pcov = curve_fit(
        model_func, x_dummy, Z_target,
        p0=initials,
        bounds=(lowers, uppers_safe),
        sigma=sigma,
        absolute_sigma=(sigma is not None),
        method='trf',
        max_nfev=10000,
    )

    # A rank-deficient Jacobian yields inf in pcov → treat as unavailable.
    if np.any(~np.isfinite(pcov)):
        pcov = None

    c.parameters_ = popt
    return popt, pcov, c.predict(frequencies)


def _do_diff_ev_fit(
    circuit_string: str,
    initials: List[float],
    lowers: List[float],
    uppers: List[float],
    frequencies: np.ndarray,
    Z: np.ndarray,
    weighting: str = 'none',
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray]:
    """Fit circuit via differential evolution. Returns (popt, pcov, Z_fit).

    DE handles multi-modal landscapes better than LM. pcov is estimated via a
    follow-up TRF fit starting from the DE solution.
    """
    model_func, c, _ = _make_model_func(circuit_string, frequencies)
    sigma = _compute_sigma(Z, weighting)

    def objective(params: np.ndarray) -> float:
        try:
            c.parameters_ = params
            Z_pred = c.predict(frequencies)
            res_r = Z.real - Z_pred.real
            res_i = Z.imag - Z_pred.imag
            if sigma is not None:
                n = len(Z)
                return float(np.sum((res_r / sigma[:n]) ** 2 + (res_i / sigma[n:]) ** 2))
            return float(np.sum(res_r ** 2 + res_i ** 2))
        except Exception:
            return 1e30

    # DE requires finite bounds; fall back to initial-value-based ranges for unbounded params.
    bounds_de = []
    for lo, hi, i0 in zip(lowers, uppers, initials):
        lo_eff = lo if np.isfinite(lo) else max(abs(i0) * 1e-6, 1e-30)
        hi_eff = hi if np.isfinite(hi) else max(abs(i0) * 1e4, 1e4)
        if lo_eff >= hi_eff:
            hi_eff = lo_eff * 1e4 + 1e-20
        bounds_de.append((lo_eff, hi_eff))

    de_result = _diff_ev(
        objective, bounds_de,
        seed=42, maxiter=1000, tol=1e-7,
        polish=True,
        workers=1,
    )
    popt = de_result.x

    # Estimate covariance via TRF from the DE optimum.
    pcov = None
    try:
        _, pcov, _ = _do_lm_fit(circuit_string, popt.tolist(), lowers, uppers,
                                  frequencies, Z, weighting)
    except Exception:
        pass

    c.parameters_ = popt
    return popt, pcov, c.predict(frequencies)


def _do_basin_hopping_fit(
    circuit_string: str,
    initials: List[float],
    lowers: List[float],
    uppers: List[float],
    frequencies: np.ndarray,
    Z: np.ndarray,
    weighting: str = 'none',
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray]:
    """Fit circuit via basin hopping (global). Returns (popt, pcov, Z_fit).

    Combines random perturbations with L-BFGS-B local steps to escape local
    minima. pcov estimated via a follow-up TRF fit from the best solution.
    """
    model_func, c, _ = _make_model_func(circuit_string, frequencies)
    sigma = _compute_sigma(Z, weighting)

    def objective(params: np.ndarray) -> float:
        try:
            c.parameters_ = params
            Z_pred = c.predict(frequencies)
            res_r = Z.real - Z_pred.real
            res_i = Z.imag - Z_pred.imag
            if sigma is not None:
                n = len(Z)
                return float(np.sum((res_r / sigma[:n]) ** 2 + (res_i / sigma[n:]) ** 2))
            return float(np.sum(res_r ** 2 + res_i ** 2))
        except Exception:
            return 1e30

    # Build finite bounds for the local minimizer step.
    bounds_bh = []
    for lo, hi, i0 in zip(lowers, uppers, initials):
        lo_eff = lo if np.isfinite(lo) else max(abs(i0) * 1e-6, 1e-30)
        hi_eff = hi if np.isfinite(hi) else max(abs(i0) * 1e4, 1e4)
        if lo_eff >= hi_eff:
            hi_eff = lo_eff * 1e4 + 1e-20
        bounds_bh.append((lo_eff, hi_eff))

    result = basinhopping(
        objective, initials,
        minimizer_kwargs={'method': 'L-BFGS-B', 'bounds': bounds_bh},
        niter=200,
        seed=42,
    )
    popt = result.x

    pcov = None
    try:
        _, pcov, _ = _do_lm_fit(circuit_string, popt.tolist(), lowers, uppers,
                                  frequencies, Z, weighting)
    except Exception:
        pass

    c.parameters_ = popt
    return popt, pcov, c.predict(frequencies)


def _do_nelder_mead_fit(
    circuit_string: str,
    initials: List[float],
    lowers: List[float],
    uppers: List[float],
    frequencies: np.ndarray,
    Z: np.ndarray,
    weighting: str = 'none',
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray]:
    """Fit circuit via Nelder-Mead simplex (local, gradient-free). Returns (popt, pcov, Z_fit).

    Bounds are enforced via a hard penalty. pcov estimated via a follow-up TRF
    fit from the Nelder-Mead solution.
    """
    model_func, c, _ = _make_model_func(circuit_string, frequencies)
    sigma = _compute_sigma(Z, weighting)

    def objective(params: np.ndarray) -> float:
        try:
            for val, lo, hi in zip(params, lowers, uppers):
                if val < lo or (np.isfinite(hi) and val > hi):
                    return 1e30
            c.parameters_ = params
            Z_pred = c.predict(frequencies)
            res_r = Z.real - Z_pred.real
            res_i = Z.imag - Z_pred.imag
            if sigma is not None:
                n = len(Z)
                return float(np.sum((res_r / sigma[:n]) ** 2 + (res_i / sigma[n:]) ** 2))
            return float(np.sum(res_r ** 2 + res_i ** 2))
        except Exception:
            return 1e30

    result = minimize(
        objective, initials,
        method='Nelder-Mead',
        options={'maxiter': 50000, 'xatol': 1e-8, 'fatol': 1e-8},
    )
    popt = result.x

    pcov = None
    try:
        _, pcov, _ = _do_lm_fit(circuit_string, popt.tolist(), lowers, uppers,
                                  frequencies, Z, weighting)
    except Exception:
        pass

    c.parameters_ = popt
    return popt, pcov, c.predict(frequencies)


# ── post-fit statistics ───────────────────────────────────────────────────────

def _compute_chi_sq_nu(
    Z: np.ndarray, Z_fit: np.ndarray, k: int, weighting: str
) -> float | None:
    """Reduced chi-squared χ²/(N−p).  N = 2·len(Z) (real+imag), p = k."""
    N = 2 * len(Z)
    dof = N - k
    if dof <= 0:
        return None
    sigma = _compute_sigma(Z, weighting)
    res_r = Z.real - Z_fit.real
    res_i = Z.imag - Z_fit.imag
    if sigma is not None:
        n = len(Z)
        chi_sq = float(np.sum((res_r / sigma[:n]) ** 2 + (res_i / sigma[n:]) ** 2))
    else:
        chi_sq = float(np.sum(res_r ** 2 + res_i ** 2))
    return chi_sq / dof


def _compute_rmse(Z: np.ndarray, Z_fit: np.ndarray) -> float:
    """RMSE of the complex impedance: sqrt(mean(|Z_meas - Z_calc|²))."""
    return float(np.sqrt(np.mean(np.abs(Z - Z_fit) ** 2)))


def _compute_correlation(pcov: np.ndarray | None) -> List[List[float]] | None:
    """Convert covariance matrix to correlation matrix. Returns None if pcov is None."""
    if pcov is None:
        return None
    try:
        diag = np.sqrt(np.diag(pcov))
        diag_safe = np.where(diag < 1e-30, 1e-30, diag)
        corr = pcov / np.outer(diag_safe, diag_safe)
        # Clip to [-1, 1] to correct any floating-point overshoot.
        corr = np.clip(corr, -1.0, 1.0)
        return corr.tolist()
    except Exception:
        return None


# ── main fitting logic ────────────────────────────────────────────────────────

def fit_single(
    frequencies: np.ndarray,
    Z: np.ndarray,
    circuit_config: CircuitConfig,
    char_values: Dict[str, Union[float, str]],
    filename: str,
    filepath: str,
    optimize_config: OptimizeConfig | None = None,
    column_map: ColumnMap | None = None,
    weighting: str = 'none',
    solver: str = 'lm',
    rs_estimate: float | None = None,
) -> FitResult:
    allowed_char = (set(column_map.characterization.keys()) if column_map else set()) | {'identifier', 'battery_id'}
    clean_char = {k: v for k, v in char_values.items() if k in allowed_char}

    name_lookup = _build_param_lookup(circuit_config)
    optimize = optimize_config is not None and optimize_config.enabled
    criterion = (optimize_config.criterion if optimize_config else None) or 'AIC'

    # Build candidate list: (circuit_string, label_for_variant)
    if optimize:
        candidates: list[tuple[str, str]] = []
        for rc in range(optimize_config.rc_min, optimize_config.rc_max + 1):
            for pt in (optimize_config.pair_types or ['CPE']):
                variant = generate_circuit_variant(circuit_config.circuit_string, rc, pt)
                if variant:
                    candidates.append((variant, f"{rc}×{pt}"))
    else:
        candidates = [(circuit_config.circuit_string, 'fixed')]

    best_result: FitResult | None = None
    best_score = float('inf')
    variants_tried: List[VariantResult] = []
    n_restarts = max(1, (optimize_config.n_restarts if optimize_config else 1))
    rng = default_rng()

    for variant_circuit, _ in candidates:
        try:
            param_names, _ = get_param_names(variant_circuit)
            initials, lowers, uppers = _resolve_bounds(param_names, name_lookup, rs_estimate)
            k = len(param_names)

            best_obj = float('inf')
            best_popt: np.ndarray | None = None
            best_pcov: np.ndarray | None = None
            Z_fit: np.ndarray = np.zeros_like(Z)

            if solver == 'diff_ev':
                # Single DE run (already global — no multi-start needed)
                popt, pcov, Z_try = _do_diff_ev_fit(
                    variant_circuit, initials, lowers, uppers,
                    frequencies, Z, weighting,
                )
                best_popt, best_pcov, Z_fit = popt, pcov, Z_try

            elif solver == 'basin_hop':
                # Single basin-hopping run (internally explores landscape)
                popt, pcov, Z_try = _do_basin_hopping_fit(
                    variant_circuit, initials, lowers, uppers,
                    frequencies, Z, weighting,
                )
                best_popt, best_pcov, Z_fit = popt, pcov, Z_try

            elif solver == 'nelder_mead':
                # Multi-start Nelder-Mead (local, gradient-free)
                for restart in range(n_restarts):
                    guess = initials if restart == 0 else _sample_initial_guess(initials, lowers, uppers, rng)
                    try:
                        popt, pcov, Z_try = _do_nelder_mead_fit(
                            variant_circuit, guess, lowers, uppers,
                            frequencies, Z, weighting,
                        )
                        mod = np.maximum(np.abs(Z), 1e-30)
                        obj = float(np.sum(((Z.real - Z_try.real) / mod) ** 2 +
                                          ((Z.imag - Z_try.imag) / mod) ** 2))
                        if obj < best_obj:
                            best_obj = obj
                            best_popt = popt
                            best_pcov = pcov
                            Z_fit = Z_try
                    except Exception:
                        continue

            else:
                # Multi-start LM
                for restart in range(n_restarts):
                    guess = initials if restart == 0 else _sample_initial_guess(initials, lowers, uppers, rng)
                    try:
                        popt, pcov, Z_try = _do_lm_fit(
                            variant_circuit, guess, lowers, uppers,
                            frequencies, Z, weighting,
                        )
                        # Rank restarts by modulus-weighted objective for consistency
                        mod = np.maximum(np.abs(Z), 1e-30)
                        obj = float(np.sum(((Z.real - Z_try.real) / mod) ** 2 +
                                          ((Z.imag - Z_try.imag) / mod) ** 2))
                        if obj < best_obj:
                            best_obj = obj
                            best_popt = popt
                            best_pcov = pcov
                            Z_fit = Z_try
                    except Exception:
                        continue

            if best_popt is None:
                raise RuntimeError("all restarts failed")

            residual = float(np.mean(np.abs(Z - Z_fit) / (np.abs(Z) + 1e-12)))
            aic, bic = _compute_aic_bic(Z, Z_fit, k)
            chi_sq_nu = _compute_chi_sq_nu(Z, Z_fit, k, weighting)
            rmse = _compute_rmse(Z, Z_fit)
            correlation = _compute_correlation(best_pcov)
            score = aic if criterion == 'AIC' else bic

            params = dict(zip(param_names, best_popt.tolist()))
            conf: Dict[str, float] = {}
            if best_pcov is not None:
                diag_errs = np.sqrt(np.diag(best_pcov))
                conf = dict(zip(param_names, diag_errs.tolist()))

            variants_tried.append(VariantResult(
                circuit_string=variant_circuit,
                n_params=k,
                residual=residual,
                aic=aic,
                bic=bic,
                success=True,
            ))

            if score < best_score:
                best_score = score
                best_result = FitResult(
                    filename=filename,
                    path=filepath,
                    success=True,
                    parameters=params,
                    param_names=param_names,
                    confidence=conf,
                    frequencies=frequencies.tolist(),
                    z_real_fit=Z_fit.real.tolist(),
                    z_imag_fit=Z_fit.imag.tolist(),
                    z_real_data=Z.real.tolist(),
                    z_imag_data=Z.imag.tolist(),
                    characterization=clean_char,
                    residual=residual,
                    rmse=rmse,
                    chi_sq_nu=chi_sq_nu,
                    aic=aic,
                    bic=bic,
                    correlation=correlation,
                    circuit_used=variant_circuit,
                )

        except Exception as exc:
            variants_tried.append(VariantResult(
                circuit_string=variant_circuit,
                n_params=0,
                success=False,
                error=str(exc),
            ))

    if best_result is not None:
        best_result.variants_tried = variants_tried
        return best_result

    return FitResult(
        filename=filename,
        path=filepath,
        success=False,
        error="All circuit variants failed to fit",
        frequencies=frequencies.tolist(),
        z_real_data=Z.real.tolist(),
        z_imag_data=Z.imag.tolist(),
        characterization=clean_char,
        circuit_used=circuit_config.circuit_string,
        variants_tried=variants_tried,
    )


async def fit_batch_stream(request: FitRequest) -> AsyncGenerator[str, None]:
    total = len(request.files)

    for i, file_info in enumerate(request.files):
        yield f"data: {json.dumps({'event': 'progress', 'file': file_info.filename, 'index': i, 'total': total})}\n\n"

        try:
            frequencies, Z, char_values = await asyncio.to_thread(
                load_eis_data, file_info.path, request.column_map
            )

            # Per-file freq range (from KK suggestion) takes priority over global range
            f_min = file_info.freq_min if file_info.freq_min is not None else request.freq_min
            f_max = file_info.freq_max if file_info.freq_max is not None else request.freq_max

            mask = np.ones(len(frequencies), dtype=bool)
            if f_min is not None:
                mask &= frequencies >= f_min
            if f_max is not None:
                mask &= frequencies <= f_max
            if not mask.all():
                if not mask.any():
                    raise ValueError(
                        f"No data points remain after applying frequency range "
                        f"{f_min}–{f_max} Hz"
                    )
                frequencies = frequencies[mask]
                Z = Z[mask]

            result = await asyncio.wait_for(
                asyncio.to_thread(
                    fit_single,
                    frequencies, Z,
                    request.circuit_config,
                    char_values,
                    file_info.filename,
                    file_info.path,
                    request.optimize_config,
                    request.column_map,
                    request.weighting,
                    request.solver,
                    file_info.rs_estimate,
                ),
                timeout=request.fit_timeout,
            )
        except asyncio.TimeoutError:
            result = FitResult(
                filename=file_info.filename, path=file_info.path,
                success=False, error=f"Fit timed out after {request.fit_timeout:g} s",
            )
        except Exception as exc:
            result = FitResult(
                filename=file_info.filename, path=file_info.path,
                success=False, error=str(exc),
            )

        yield f"data: {json.dumps({'event': 'result', 'data': result.model_dump()})}\n\n"

    yield f"data: {json.dumps({'event': 'done'})}\n\n"
