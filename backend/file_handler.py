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


def load_eis_data(
    filepath: str,
    column_map: ColumnMap,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Union[float, str]]]:
    df = pd.read_csv(filepath)

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

    # Use the actual parent folder name as the battery identifier.
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

        series = df[col_name]

        # Numeric characterization columns: optionally round to specified decimals,
        # then average all numeric values, then round final average to 1 decimal place.
        numeric_vals = pd.to_numeric(series, errors="coerce").dropna()
        if len(numeric_vals):
            # Apply per-parameter decimal rounding if specified
            decimals = column_map.decimal_places.get(label, None)
            if decimals is not None:
                numeric_vals = numeric_vals.round(decimals)
            # Average and round final result to 1 decimal
            char_values[label] = round(float(numeric_vals.mean()), 1)
            continue

        # Non-numeric characterization columns: use the first non-empty value.
        non_empty = series.dropna().astype(str).str.strip()
        non_empty = non_empty[non_empty != ""]
        if len(non_empty):
            char_values[label] = non_empty.iloc[0]

    # Fallback: if an identifier-like column exists but was not mapped,
    # extract it automatically so Trends can still expose it.
    if "identifier" not in char_values:
        id_col = next((c for c in df.columns if _ROLE_PATTERNS["identifier"].search(str(c))), None)
        if id_col is not None:
            series = df[id_col]
            numeric_vals = pd.to_numeric(series, errors="coerce").dropna()
            if len(numeric_vals):
                char_values["identifier"] = round(float(numeric_vals.mean()), 1)
            else:
                non_empty = series.dropna().astype(str).str.strip()
                non_empty = non_empty[non_empty != ""]
                if len(non_empty):
                    char_values["identifier"] = non_empty.iloc[0]

    # Inject battery_id as the folder name string.
    if battery_id_str:
        char_values["battery_id"] = battery_id_str

    return frequencies, Z, char_values


def characterize_files(files, column_map) -> list:
    results = []
    for f in files:
        try:
            df = pd.read_csv(f.path)
            battery_id_str = Path(f.path).parent.name or None
            pb_char = column_map.per_battery_characterization or {}
            all_labels = list(column_map.characterization.keys()) + [
                lbl for lbl in pb_char if lbl not in column_map.characterization
            ]
            char_values: Dict[str, Union[float, str]] = {}
            for label in all_labels:
                col_name = column_map.characterization.get(label, '')
                if battery_id_str and label in pb_char:
                    col_name = pb_char[label].get(battery_id_str, col_name)
                if not col_name or col_name not in df.columns:
                    continue
                series = df[col_name]
                numeric_vals = pd.to_numeric(series, errors="coerce").dropna()
                if len(numeric_vals):
                    decimals = column_map.decimal_places.get(label, None)
                    if decimals is not None:
                        numeric_vals = numeric_vals.round(decimals)
                    char_values[label] = round(float(numeric_vals.mean()), 1)
                    continue
                non_empty = series.dropna().astype(str).str.strip()
                non_empty = non_empty[non_empty != ""]
                if len(non_empty):
                    char_values[label] = non_empty.iloc[0]
            if "identifier" not in char_values:
                id_col = next((c for c in df.columns if _ROLE_PATTERNS["identifier"].search(str(c))), None)
                if id_col is not None:
                    series = df[id_col]
                    numeric_vals = pd.to_numeric(series, errors="coerce").dropna()
                    if len(numeric_vals):
                        char_values["identifier"] = round(float(numeric_vals.mean()), 1)
                    else:
                        non_empty = series.dropna().astype(str).str.strip()
                        non_empty = non_empty[non_empty != ""]
                        if len(non_empty):
                            char_values["identifier"] = non_empty.iloc[0]
            if battery_id_str:
                char_values["battery_id"] = battery_id_str
            results.append({"path": f.path, "characterization": char_values})
        except Exception:
            results.append({"path": f.path, "characterization": {}})
    return results
