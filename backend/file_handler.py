from __future__ import annotations
import re
from pathlib import Path
from typing import Dict, List, Tuple, Union

import numpy as np
import pandas as pd

from .models import ColumnMap, FileInfo

_ROLE_PATTERNS: Dict[str, re.Pattern] = {
    "frequency":   re.compile(r"freq|hz|frequency", re.IGNORECASE),
    "real_z":      re.compile(r"zreal|z_re|z\.re|impedance_real|\breal\b|z'$", re.IGNORECASE),
    "imag_z":      re.compile(r"zimag|z_im|z\.im|impedance_imag|\bimag\b|z''$", re.IGNORECASE),
    "temperature": re.compile(r"temp|celsius|kelvin|°c|degc", re.IGNORECASE),
    "voltage":     re.compile(r"volt|voltage|_v$|^v$|^v_", re.IGNORECASE),
    "soc":         re.compile(r"\bsoc\b|state.of.charge", re.IGNORECASE),
    "identifier":  re.compile(r"identifier|sample[_\s-]?id|test[_\s-]?id|\bid\b", re.IGNORECASE),
}


def scan_folder(folder_path: str) -> Tuple[List[FileInfo], Dict[str, str]]:
    folder = Path(folder_path.strip()).resolve()
    if not folder.exists() or not folder.is_dir():
        raise ValueError(f"Folder not found: {folder}")

    # Accept CSVs directly in the folder OR one level deep (battery-cell subfolders).
    # Use a set to deduplicate — Windows glob is case-insensitive so *.csv and *.CSV
    # can return the same paths twice.
    seen: set = set()
    csv_paths: List[Path] = []
    for p in (
        sorted(folder.glob("*.csv")) + sorted(folder.glob("*.CSV")) +
        [p for sub in sorted(s for s in folder.iterdir() if s.is_dir())
           for p in sorted(sub.glob("*.csv")) + sorted(sub.glob("*.CSV"))]
    ):
        if p not in seen:
            seen.add(p)
            csv_paths.append(p)

    if not csv_paths:
        raise ValueError(f"No CSV files found in: {folder_path}")

    file_infos: List[FileInfo] = []
    for p in csv_paths:
        try:
            df = pd.read_csv(p, nrows=3)
            row_count = sum(1 for _ in open(p, encoding="utf-8", errors="replace")) - 1
            file_infos.append(FileInfo(
                filename=p.name,
                path=str(p),
                columns=list(df.columns),
                row_count=max(row_count, 0),
            ))
        except Exception:
            continue

    if not file_infos:
        raise ValueError(f"No valid CSV files found in: {folder_path}")

    detected_roles = detect_column_roles(file_infos[0].columns)
    return file_infos, detected_roles


def detect_column_roles(columns: List[str]) -> Dict[str, str]:
    roles: Dict[str, str] = {}
    for col in columns:
        for role, pattern in _ROLE_PATTERNS.items():
            if role not in roles and pattern.search(col):
                roles[role] = col
    return roles


def _column_value(series: pd.Series, decimals: Union[int, None]) -> Union[float, str, None]:
    """Reduce a characterization column to a single value.

    Numeric columns: mean of all numeric values, rounded only when the user
    specified a decimal count for this label (used to bin near-identical
    conditions).  No forced rounding otherwise — a 3.742 V OCV must not
    silently become 3.7.
    Non-numeric columns: first non-empty string.
    """
    numeric_vals = pd.to_numeric(series, errors="coerce").dropna()
    if len(numeric_vals):
        mean_val = float(numeric_vals.mean())
        return round(mean_val, decimals) if decimals is not None else mean_val
    non_empty = series.dropna().astype(str).str.strip()
    non_empty = non_empty[non_empty != ""]
    if len(non_empty):
        return non_empty.iloc[0]
    return None


def _extract_char_values(
    df: pd.DataFrame,
    filepath: str,
    column_map: ColumnMap,
) -> Dict[str, Union[float, str]]:
    """Extract characterization values for one file (shared by load & characterize)."""
    battery_id_str = Path(filepath).parent.name or None

    # Process all labels: union of global and per-battery characterization keys.
    pb_char = column_map.per_battery_characterization or {}
    all_labels = list(column_map.characterization.keys()) + [
        lbl for lbl in pb_char if lbl not in column_map.characterization
    ]

    char_values: Dict[str, Union[float, str]] = {}
    for label in all_labels:
        # Per-battery override takes precedence over global mapping.
        col_name = column_map.characterization.get(label, '')
        if battery_id_str and label in pb_char:
            col_name = pb_char[label].get(battery_id_str, col_name)

        if not col_name or col_name not in df.columns:
            continue

        value = _column_value(df[col_name], column_map.decimal_places.get(label))
        if value is not None:
            char_values[label] = value

    # Fallback: if an identifier-like column exists but was not mapped,
    # extract it automatically so Trends can still expose it.
    if "identifier" not in char_values:
        id_col = next((c for c in df.columns if _ROLE_PATTERNS["identifier"].search(str(c))), None)
        if id_col is not None:
            value = _column_value(df[id_col], None)
            if value is not None:
                char_values["identifier"] = value

    # Inject battery_id as the folder name string.
    if battery_id_str:
        char_values["battery_id"] = battery_id_str

    return char_values


def _skiprows(column_map: ColumnMap):
    """Rows to skip when reading data. When skip_first_data_row is set, drop the
    first line after the header (line index 1) — e.g. a units row."""
    return [1] if column_map.skip_first_data_row else None


def load_eis_data(
    filepath: str,
    column_map: ColumnMap,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Union[float, str]]]:
    df = pd.read_csv(filepath, skiprows=_skiprows(column_map))

    frequencies = df[column_map.frequency].to_numpy(dtype=float)
    z_real      = df[column_map.real_z].to_numpy(dtype=float)
    z_imag      = df[column_map.imag_z].to_numpy(dtype=float)

    if column_map.negate_imag:
        z_imag = -z_imag

    Z = z_real + 1j * z_imag

    # Drop non-positive frequencies only. Inductive points (Z.imag > 0) are
    # kept — they are needed for accurate HF intercept detection via KK.
    mask = frequencies > 0
    frequencies = frequencies[mask]
    Z = Z[mask]

    char_values = _extract_char_values(df, filepath, column_map)

    return frequencies, Z, char_values


def characterize_files(files, column_map) -> list:
    results = []
    for f in files:
        try:
            df = pd.read_csv(f.path, skiprows=_skiprows(column_map))
            char_values = _extract_char_values(df, f.path, column_map)
            results.append({"path": f.path, "characterization": char_values})
        except Exception:
            results.append({"path": f.path, "characterization": {}})
    return results
