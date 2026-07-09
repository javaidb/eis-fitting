"""Lin-KK wrapper: suggested frequency band and Nyquist intercepts."""
import numpy as np
import pytest

from backend.kk import run_kk_single, _find_nyquist_intercepts


class TestSuggestedBand:
    def test_band_is_contiguous_compliant(self, spectrum_1rc_dense):
        """Every point inside the suggested band must itself be compliant."""
        f, Z = spectrum_1rc_dense
        Zg = Z.copy()
        Zg[60] *= 1.10   # non-compliant glitch mid-band
        kk = run_kk_single(f, Zg, residual_threshold=0.01)
        assert kk.freq_min_suggest is not None
        rm = np.array(kk.residual_magnitude)
        in_band = (f >= kk.freq_min_suggest) & (f <= kk.freq_max_suggest)
        assert np.all(rm[in_band] <= 0.01)

    def test_band_excludes_glitch(self, spectrum_1rc_dense):
        f, Z = spectrum_1rc_dense
        Zg = Z.copy()
        Zg[60] *= 1.10
        kk = run_kk_single(f, Zg, residual_threshold=0.01)
        glitch_f = f[60]
        assert 60 in kk.flagged_indices
        assert not (kk.freq_min_suggest <= glitch_f <= kk.freq_max_suggest)


class TestNyquistIntercepts:
    def test_hf_intercept_interpolates_zero_crossing(self):
        # Inductive at HF (−Z'' < 0) crossing to capacitive: intercept at Z' = 0.010
        f = np.logspace(5, 0, 50)
        w = 2 * np.pi * f
        Z = 0.010 + 0.030 / (1 + 1j * w * 0.030 * 0.5) + 1j * w * 1e-8
        hf, lf = _find_nyquist_intercepts(f, Z)
        assert hf == pytest.approx(0.010, rel=0.05)

    def test_lf_intercept_from_circle_fit(self, spectrum_1rc_dense):
        f, Z = spectrum_1rc_dense
        hf, lf = _find_nyquist_intercepts(f, Z)
        assert hf == pytest.approx(0.010, rel=0.1)
        assert lf == pytest.approx(0.040, rel=0.1)   # R0 + R1
