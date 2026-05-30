from __future__ import annotations
import re
from pathlib import Path
from typing import Dict, List, Tuple, Optional

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
) -> Tuple[np.ndarray, np.ndarray, Dict[str, float]]:
    df = pd.read_csv(filepath)

    frequencies = df[column_map.frequency].to_numpy(dtype=float)
    z_real      = df[column_map.real_z].to_numpy(dtype=float)
    z_imag      = df[column_map.imag_z].to_numpy(dtype=float)

    if column_map.negate_imag:
        z_imag = -z_imag

    Z = z_real + 1j * z_imag

    # Drop non-positive frequencies and inductive artifacts (Z.imag > 0
    # means the point dips below the real axis on a Nyquist plot).
    mask = (frequencies > 0) & (Z.imag <= 0)
    frequencies = frequencies[mask]
    Z = Z[mask]

    char_values: Dict[str, float] = {}
    for label, col_name in column_map.characterization.items():
        if col_name in df.columns:
            val = pd.to_numeric(df[col_name], errors="coerce").dropna()
            if len(val):
                char_values[label] = float(val.iloc[0])

    # Inject battery_id from the parent subfolder name (trailing number, e.g. battery_02 → 2)
    parent = Path(filepath).parent.name
    m = re.search(r"(\d+)$", parent)
    if m:
        char_values["battery_id"] = float(m.group(1))

    return frequencies, Z, char_values
