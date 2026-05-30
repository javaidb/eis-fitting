from __future__ import annotations
import re
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

from .models import ColumnMap, FileInfo

_ROLE_PATTERNS: Dict[str, re.Pattern] = {
    "frequency": re.compile(r"freq|hz|frequency", re.IGNORECASE),
    "real_z":    re.compile(r"re.*z|z.*re|zreal|z_re|z\.re|real|z'$", re.IGNORECASE),
    "imag_z":    re.compile(r"im.*z|z.*im|zimag|z_im|z\.im|imag|z''$", re.IGNORECASE),
    "temperature": re.compile(r"temp|celsius|kelvin|°c|degc", re.IGNORECASE),
    "voltage":   re.compile(r"volt|voltage|_v$|^v$|^v_", re.IGNORECASE),
}


def scan_folder(folder_path: str) -> Tuple[List[FileInfo], Dict[str, str]]:
    # resolve() converts relative paths (from manual typing) and normalises
    # forward-slash Windows paths returned by tkinter's folder picker.
    folder = Path(folder_path.strip()).resolve()
    if not folder.exists() or not folder.is_dir():
        raise ValueError(f"Folder not found: {folder}")

    csv_paths = sorted(folder.glob("*.csv")) + sorted(folder.glob("*.CSV"))
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

    detected_roles: Dict[str, str] = {}
    if file_infos:
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
    z_real = df[column_map.real_z].to_numpy(dtype=float)
    z_imag = df[column_map.imag_z].to_numpy(dtype=float)

    if column_map.negate_imag:
        z_imag = -z_imag

    Z = z_real + 1j * z_imag

    # Remove non-positive frequencies
    mask = frequencies > 0
    frequencies = frequencies[mask]
    Z = Z[mask]

    char_values: Dict[str, float] = {}
    for label, col_name in column_map.characterization.items():
        if col_name in df.columns:
            val = pd.to_numeric(df[col_name], errors="coerce").dropna()
            if len(val):
                char_values[label] = float(val.iloc[0])

    return frequencies, Z, char_values
