"""Fitting: weighting, statistics, parameter fixing, cancellation, envelope."""
import numpy as np
import pytest

from backend.fitting import (
    FitInterrupted,
    compute_fit_envelope,
    fit_single,
    _compute_aic_bic,
    _compute_sigma,
    _expand_pcov,
    _fit_objective,
    _resolve_bounds,
    _split_free,
)
from backend.models import CircuitConfig


def _config(**overrides):
    base = dict(
        circuit_string="R0-p(R1,C1)-p(R2,C2)",
        param_names=["R0", "R1", "C1", "R2", "C2"],
        initial_guess=[0.01, 0.01, 0.01, 0.01, 1.0],
        lower_bounds=[0, 0, 0, 0, 0],
        upper_bounds=[None] * 5,
    )
    base.update(overrides)
    return CircuitConfig(**base)


TRUE = {"R0": 0.010, "R1": 0.020, "C1": 0.05, "R2": 0.030, "C2": 3.33}


class TestWeighting:
    def test_none_gives_no_sigma(self):
        Z = np.array([1 + 1j, 2 - 2j])
        assert _compute_sigma(Z, "none") is None

    def test_modulus_sigma(self):
        Z = np.array([3 + 4j])
        s = _compute_sigma(Z, "modulus")
        assert s.shape == (2,)
        assert s[0] == pytest.approx(5.0)
        assert s[1] == pytest.approx(5.0)

    def test_proportional_floors_imag(self):
        Z = np.array([1.0 + 0j])   # Z'' = 0 → floor kicks in
        s = _compute_sigma(Z, "proportional")
        assert s[1] > 0

    def test_objective_consistent_with_sigma(self):
        Z = np.array([1 + 1j, 2 - 2j])
        Z_fit = np.array([1.1 + 0.9j, 1.9 - 2.1j])
        # Unweighted = plain SSR
        expected = np.sum((Z.real - Z_fit.real) ** 2 + (Z.imag - Z_fit.imag) ** 2)
        assert _fit_objective(Z, Z_fit, "none") == pytest.approx(expected)
        # Weighted differs from unweighted
        assert _fit_objective(Z, Z_fit, "modulus") != pytest.approx(expected)


class TestAicBic:
    def test_better_fit_scores_lower(self):
        Z = np.array([1 + 1j, 2 - 2j, 3 + 0.5j])
        good = Z * (1 + 0.001)
        bad = Z * (1 + 0.1)
        aic_good, bic_good = _compute_aic_bic(Z, good, 3)
        aic_bad, bic_bad = _compute_aic_bic(Z, bad, 3)
        assert aic_good < aic_bad
        assert bic_good < bic_bad

    def test_weighting_changes_score(self):
        Z = np.array([1 + 1j, 20 - 20j])
        Z_fit = Z * (1 + 0.01)
        aic_w, _ = _compute_aic_bic(Z, Z_fit, 2, "modulus")
        aic_u, _ = _compute_aic_bic(Z, Z_fit, 2, "none")
        assert aic_w != pytest.approx(aic_u)


class TestResolveBounds:
    def test_user_lookup_wins_over_type_default(self):
        lookup = {"R0": (0.5, 0.1, 2.0)}
        init, lo, hi = _resolve_bounds(["R0", "R1"], lookup)
        assert (init[0], lo[0], hi[0]) == (0.5, 0.1, 2.0)
        assert init[1] == 0.01   # type default for R

    def test_rs_estimate_seeds_r0(self):
        init, _, _ = _resolve_bounds(["R0", "R1"], {}, rs_estimate=0.042)
        assert init[0] == pytest.approx(0.042)
        assert init[1] == 0.01   # only R0 is seeded


class TestSplitFree:
    def test_fixed_detection_and_embed(self):
        free_ix, embed = _split_free([1.0, 2.0, 3.0], [0.0, 5.0, 0.0], [np.inf, 5.0, np.inf])
        assert free_ix == [0, 2]
        full = embed([10.0, 30.0])
        assert full.tolist() == [10.0, 5.0, 30.0]   # fixed param pinned at bound value

    def test_no_fixed(self):
        free_ix, embed = _split_free([1.0], [0.0], [np.inf])
        assert free_ix == [0]
        assert embed([7.0]).tolist() == [7.0]

    def test_expand_pcov_zero_rows_for_fixed(self):
        pcov_free = np.array([[1.0, 0.5], [0.5, 2.0]])
        full = _expand_pcov(pcov_free, [0, 2], 3)
        assert full.shape == (3, 3)
        assert full[1].tolist() == [0, 0, 0]
        assert full[0, 2] == 0.5


class TestFitSingle:
    def test_recovers_true_parameters(self, spectrum_2rc):
        f, Z = spectrum_2rc
        res = fit_single(f, Z, _config(), {}, "s.csv", "s.csv", weighting="modulus")
        assert res.success
        for name, true_val in TRUE.items():
            assert res.parameters[name] == pytest.approx(true_val, rel=0.02)
        assert res.residual < 0.01
        assert res.correlation is not None

    def test_fixed_parameter_stays_pinned(self, spectrum_2rc):
        f, Z = spectrum_2rc
        pin = 0.012   # deliberately NOT the true R0
        cfg = _config(lower_bounds=[pin, 0, 0, 0, 0], upper_bounds=[pin, None, None, None, None],
                      initial_guess=[pin, 0.01, 0.01, 0.01, 1.0])
        res = fit_single(f, Z, cfg, {}, "s.csv", "s.csv")
        assert res.success
        assert res.parameters["R0"] == pin                    # exactly the pinned value
        assert res.confidence.get("R0", 0.0) == 0.0           # no uncertainty on a constant
        # Free parameters still fit (approximately — R0 is wrong on purpose)
        assert res.parameters["R2"] == pytest.approx(TRUE["R2"], rel=0.25)

    def test_all_solvers_accept_fixed_params(self, spectrum_2rc):
        f, Z = spectrum_2rc
        cfg = _config(lower_bounds=[0.010, 0, 0, 0, 0],
                      upper_bounds=[0.010, None, None, None, None],
                      initial_guess=[0.010, 0.01, 0.01, 0.01, 1.0])
        res = fit_single(f, Z, cfg, {}, "s.csv", "s.csv", solver="nelder_mead")
        assert res.success
        assert res.parameters["R0"] == 0.010

    def test_cancellation_raises(self, spectrum_2rc):
        f, Z = spectrum_2rc
        with pytest.raises(FitInterrupted):
            fit_single(f, Z, _config(), {}, "s.csv", "s.csv", should_stop=lambda: True)


class TestEnvelope:
    def test_shapes_and_fallback(self, spectrum_2rc):
        f, Z = spectrum_2rc
        params = dict(TRUE)
        conf = {k: abs(v) * 0.01 for k, v in TRUE.items()}
        out = compute_fit_envelope("R0-p(R1,C1)-p(R2,C2)", params, conf, f, 50)
        assert all(len(arr) == len(f) for arr in out)
        # upper >= lower everywhere
        assert np.all(out[0] >= out[1])

    def test_correlation_used_when_ordered(self, spectrum_2rc):
        f, _ = spectrum_2rc
        params = dict(TRUE)
        conf = {k: abs(v) * 0.05 for k, v in TRUE.items()}
        names = list(TRUE.keys())
        identity = np.eye(5).tolist()
        env_corr = compute_fit_envelope("R0-p(R1,C1)-p(R2,C2)", params, conf, f, 100,
                                        names, identity)
        env_ind = compute_fit_envelope("R0-p(R1,C1)-p(R2,C2)", params, conf, f, 100)
        # Identity correlation ≡ independent sampling (same RNG seed → near-identical width)
        w_corr = float(np.mean(env_corr[0] - env_corr[1]))
        w_ind = float(np.mean(env_ind[0] - env_ind[1]))
        assert w_corr == pytest.approx(w_ind, rel=0.3)
