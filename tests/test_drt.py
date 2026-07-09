"""DRT: NNLS solver, L-curve, complex (Re+Im) mode, peak merging."""
import numpy as np
import pytest

from backend.drt import (
    compute_drt,
    compute_lcurve_data,
    _build_kernel,
    _merge_nearby_peaks,
    _solve_drt_system,
    _solve_tikhonov,
)

TAU1, TAU2 = 1e-3, 0.0999   # true time constants of spectrum_2rc


class TestNNLSSolver:
    def test_gamma_non_negative(self, spectrum_2rc):
        f, Z = spectrum_2rc
        res = compute_drt(f, Z, lambda_reg=1e-4)
        assert np.all(np.array(res.gamma) >= 0)

    def test_recovers_both_time_constants(self, spectrum_2rc):
        f, Z = spectrum_2rc
        res = compute_drt(f, Z, lambda_reg=1e-3)
        taus = sorted(p["tau_center"] for p in res.peaks)
        assert len(taus) == 2
        assert np.log10(taus[0]) == pytest.approx(np.log10(TAU1), abs=0.15)
        assert np.log10(taus[1]) == pytest.approx(np.log10(TAU2), abs=0.15)

    def test_nnls_fits_no_worse_than_clipped_solve(self, spectrum_2rc):
        f, Z = spectrum_2rc
        _, K, _, L = _build_kernel(f)
        rhs = -Z.imag
        lam = 1e-6
        g_nnls = _solve_tikhonov(K, L, rhs, lam)
        A = K.T @ K + lam * (L.T @ L)
        g_clip = np.maximum(np.linalg.solve(A, K.T @ rhs), 0.0)
        assert np.linalg.norm(K @ g_nnls - rhs) <= np.linalg.norm(K @ g_clip - rhs) + 1e-12


class TestLCurve:
    def test_residual_monotone_and_interior_corner(self, spectrum_2rc):
        f, Z = spectrum_2rc
        lc = compute_lcurve_data(f, Z)
        rn = np.array([p["residual_norm"] for p in lc["points"]])
        # Monotone non-decreasing in λ (true NNLS property; tolerate float noise)
        assert np.all(np.diff(rn) >= -1e-9 * rn[:-1])
        assert 0 < lc["optimal_index"] < len(lc["points"]) - 1

    def test_drt_at_optimal_lambda_finds_two_peaks(self, spectrum_2rc):
        f, Z = spectrum_2rc
        lc = compute_lcurve_data(f, Z)
        res = compute_drt(f, Z, lambda_reg=lc["optimal_lambda"])
        assert len(res.peaks) == 2


class TestComplexMode:
    def test_recovers_r_inf_and_peaks(self, spectrum_2rc):
        f, Z = spectrum_2rc
        res = compute_drt(f, Z, lambda_reg=1e-3, mode="complex")
        assert res.mode == "complex"
        assert res.r_inf == pytest.approx(0.010, rel=0.2)
        taus = sorted(p["tau_center"] for p in res.peaks)
        assert len(taus) == 2
        assert np.log10(taus[0]) == pytest.approx(np.log10(TAU1), abs=0.2)
        assert np.log10(taus[1]) == pytest.approx(np.log10(TAU2), abs=0.2)

    def test_recovers_series_inductance(self, spectrum_2rc):
        f, Z = spectrum_2rc
        L_true = 1e-7
        Z_ind = Z + 1j * 2 * np.pi * f * L_true
        res = compute_drt(f, Z_ind, lambda_reg=1e-3, mode="complex")
        assert res.inductance == pytest.approx(L_true, rel=0.5)

    def test_imag_mode_has_no_extras(self, spectrum_2rc):
        f, Z = spectrum_2rc
        res = compute_drt(f, Z, lambda_reg=1e-3, mode="imag")
        assert res.r_inf is None and res.inductance is None

    def test_lcurve_complex_mode(self, spectrum_2rc):
        f, Z = spectrum_2rc
        lc = compute_lcurve_data(f, Z, mode="complex")
        rn = np.array([p["residual_norm"] for p in lc["points"]])
        assert np.all(np.diff(rn) >= -1e-9 * rn[:-1])
        assert 0 < lc["optimal_index"] < len(lc["points"]) - 1

    def test_solver_system_dimensions(self, spectrum_2rc):
        f, Z = spectrum_2rc
        _, K_im, K_re, L = _build_kernel(f, 80)
        gamma, r_inf, induct = _solve_drt_system(f, Z, K_im, K_re, L, 1e-3, "complex")
        assert gamma.shape == (80,)
        assert r_inf >= 0 and induct >= 0


class TestMergeNearbyPeaks:
    def test_overlapping_peaks_merge(self):
        log_tau = np.linspace(-5, 1, 100)
        # Two heavily overlapping Gaussians → one hump
        g = (np.exp(-0.5 * ((log_tau + 2.0) / 0.5) ** 2) +
             np.exp(-0.5 * ((log_tau + 1.7) / 0.5) ** 2))
        peaks = [
            {"amplitude": 1.0, "log_tau_center": -2.0, "tau_center": 1e-2, "sigma": 0.5, "r2": 0.9},
            {"amplitude": 1.0, "log_tau_center": -1.7, "tau_center": 10 ** -1.7, "sigma": 0.5, "r2": 0.9},
        ]
        merged = _merge_nearby_peaks(log_tau, g, peaks)
        assert len(merged) == 1
        assert merged[0]["_merged_count"] == 2
        assert merged[0]["log_tau_center"] == pytest.approx(-1.85, abs=0.05)

    def test_distinct_peaks_survive(self):
        log_tau = np.linspace(-5, 1, 200)
        g = (np.exp(-0.5 * ((log_tau + 4.0) / 0.2) ** 2) +
             np.exp(-0.5 * ((log_tau + 1.0) / 0.2) ** 2))
        peaks = [
            {"amplitude": 1.0, "log_tau_center": -4.0, "tau_center": 1e-4, "sigma": 0.2, "r2": 0.9},
            {"amplitude": 1.0, "log_tau_center": -1.0, "tau_center": 1e-1, "sigma": 0.2, "r2": 0.9},
        ]
        assert len(_merge_nearby_peaks(log_tau, g, peaks)) == 2
