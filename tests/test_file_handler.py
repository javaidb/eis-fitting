"""File handling: characterization extraction, rounding rules, data loading."""
import numpy as np
import pandas as pd
import pytest

from backend.file_handler import (
    detect_column_roles,
    load_eis_data,
    _column_value,
    _extract_char_values,
)
from backend.models import ColumnMap


def _cmap(**overrides):
    base = dict(frequency="freq", real_z="zr", imag_z="zi", characterization={})
    base.update(overrides)
    return ColumnMap(**base)


class TestColumnValue:
    def test_numeric_mean_full_precision(self):
        s = pd.Series([3.7421, 3.7421])
        assert _column_value(s, None) == pytest.approx(3.7421, abs=1e-12)

    def test_decimals_rounds_mean(self):
        s = pd.Series([25.04, 24.98])
        assert _column_value(s, 0) == 25.0

    def test_non_numeric_first_non_empty(self):
        s = pd.Series([None, "  ", "cell-A", "cell-B"])
        assert _column_value(s, None) == "cell-A"

    def test_empty_returns_none(self):
        assert _column_value(pd.Series([None, ""]), None) is None


class TestExtractCharValues:
    def test_mapped_labels_and_battery_id(self):
        df = pd.DataFrame({"ocv": [3.71, 3.73], "temp": [24.9, 25.1]})
        cm = _cmap(characterization={"ocv": "ocv", "temp": "temp"},
                   decimal_places={"temp": 0})
        ch = _extract_char_values(df, r"C:\data\cell01\sweep.csv", cm)
        assert ch["ocv"] == pytest.approx(3.72)
        assert ch["temp"] == 25.0
        assert ch["battery_id"] == "cell01"

    def test_per_battery_override(self):
        df = pd.DataFrame({"soc_a": [50.0], "soc_b": [80.0]})
        cm = _cmap(characterization={"soc": "soc_a"},
                   per_battery_characterization={"soc": {"cell02": "soc_b"}})
        ch = _extract_char_values(df, r"C:\data\cell02\sweep.csv", cm)
        assert ch["soc"] == 80.0

    def test_identifier_fallback_detection(self):
        df = pd.DataFrame({"Sample_ID": ["S-17", "S-17"], "zr": [1.0, 2.0]})
        ch = _extract_char_values(df, r"C:\data\cell01\sweep.csv", _cmap())
        assert ch["identifier"] == "S-17"

    def test_missing_column_skipped(self):
        df = pd.DataFrame({"zr": [1.0]})
        cm = _cmap(characterization={"ocv": "nonexistent"})
        ch = _extract_char_values(df, r"C:\data\cell01\sweep.csv", cm)
        assert "ocv" not in ch


class TestLoadEisData:
    def _write_csv(self, tmp_path, negate=False):
        f = np.array([1000.0, 100.0, 10.0, -5.0, 0.0])   # two invalid frequencies
        zr = np.array([1.0, 2.0, 3.0, 9.0, 9.0])
        zi = np.array([-0.5, -1.0, -0.3, 9.0, 9.0])
        p = tmp_path / "spec.csv"
        pd.DataFrame({"freq": f, "zr": zr, "zi": zi}).to_csv(p, index=False)
        return str(p)

    def test_drops_non_positive_frequencies(self, tmp_path):
        path = self._write_csv(tmp_path)
        f, Z, _ = load_eis_data(path, _cmap())
        assert len(f) == 3
        assert np.all(f > 0)

    def test_negate_imag(self, tmp_path):
        path = self._write_csv(tmp_path)
        _, Z_plain, _ = load_eis_data(path, _cmap())
        _, Z_neg, _ = load_eis_data(path, _cmap(negate_imag=True))
        assert np.allclose(Z_neg.imag, -Z_plain.imag)


class TestDetectColumnRoles:
    def test_common_names(self):
        roles = detect_column_roles(["Frequency (Hz)", "Zreal", "Zimag", "Temp_C", "SOC"])
        assert roles["frequency"] == "Frequency (Hz)"
        assert roles["real_z"] == "Zreal"
        assert roles["imag_z"] == "Zimag"
        assert roles["temperature"] == "Temp_C"
        assert roles["soc"] == "SOC"
