"""Circuit-string manipulation: parameter counting, type keys, variant generation."""
import numpy as np
import pytest

from backend.fitting import (
    count_circuit_params,
    get_param_names,
    generate_circuit_variant,
    _param_type_key,
    _sample_initial_guess,
    _strip_rc_pairs,
)


class TestCountCircuitParams:
    def test_simple_rc(self):
        assert count_circuit_params("R0-p(R1,C1)") == 3

    def test_cpe_counts_two(self):
        assert count_circuit_params("R0-p(R1,CPE1)") == 4

    def test_two_param_elements(self):
        assert count_circuit_params("Wo0") == 2
        assert count_circuit_params("Ws0") == 2
        assert count_circuit_params("La0") == 2
        assert count_circuit_params("G0") == 2

    def test_full_battery_circuit(self):
        # R0 + La0 (2) + 2×(R + CPE) (6) + Wo (2) = 11
        assert count_circuit_params("La0-R0-p(R1,CPE1)-p(R2,CPE2)-Wo0") == 11


class TestParamTypeKey:
    @pytest.mark.parametrize("name,expected", [
        ("R2", "R"),
        ("C0", "C"),
        ("CPE1_0", "CPE_0"),
        ("CPE1_1", "CPE_1"),
        ("Wo0_1", "Wo_1"),
        ("G3_0", "G_0"),
        ("not-a-param", "not-a-param"),
    ])
    def test_type_key(self, name, expected):
        assert _param_type_key(name) == expected


class TestGetParamNames:
    def test_names_match_impedance_convention(self):
        names, units = get_param_names("R0-p(R1,CPE1)")
        assert names == ["R0", "R1", "CPE1_0", "CPE1_1"]
        assert len(units) == 4


class TestStripRcPairs:
    def test_strips_trailing_pairs(self):
        assert _strip_rc_pairs("R0-p(R1,C1)-p(R2,CPE2)") == "R0"

    def test_strips_leading_pair(self):
        assert _strip_rc_pairs("p(R1,CPE1)-R0") == "R0"

    def test_sole_pair_becomes_empty(self):
        assert _strip_rc_pairs("p(R1,C1)") == ""

    def test_non_rc_parallel_untouched(self):
        assert _strip_rc_pairs("R0-p(R1,W1)") == "R0-p(R1,W1)"


class TestGenerateCircuitVariant:
    def test_replaces_pair_count(self):
        v = generate_circuit_variant("R0-p(R1,CPE1)", 2, "CPE")
        assert v == "R0-p(R1,CPE1)-p(R2,CPE2)"

    def test_zero_pairs_returns_frame(self):
        assert generate_circuit_variant("R0-p(R1,CPE1)", 0, "CPE") == "R0"

    def test_inserts_before_trailing_warburg(self):
        v = generate_circuit_variant("R0-p(R1,CPE1)-Wo0", 2, "CPE")
        assert v == "R0-p(R1,CPE1)-p(R2,CPE2)-Wo0"

    def test_pair_type_c(self):
        v = generate_circuit_variant("R0", 1, "C")
        assert v == "R0-p(R1,C1)"

    def test_pairs_only_circuit_returns_none(self):
        assert generate_circuit_variant("p(R1,C1)", 1, "CPE") is None

    def test_variants_are_valid_circuits(self):
        v = generate_circuit_variant("R0-p(R1,CPE1)-Wo0", 3, "CPE")
        names, _ = get_param_names(v)   # raises if the string is invalid
        assert len(names) == count_circuit_params(v)


class TestSampleInitialGuess:
    def test_respects_bounds(self):
        rng = np.random.default_rng(1)
        initials = [0.01, 0.5]
        lowers = [1e-4, 0.0]
        uppers = [1.0, 1.0]
        for _ in range(50):
            g = _sample_initial_guess(initials, lowers, uppers, rng)
            for v, lo, hi in zip(g, lowers, uppers):
                assert lo <= v <= hi

    def test_fixed_param_stays_pinned(self):
        rng = np.random.default_rng(1)
        g = _sample_initial_guess([0.5], [0.123], [0.123], rng)
        assert g == [0.123]
