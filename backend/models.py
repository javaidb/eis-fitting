from __future__ import annotations
from typing import Dict, List, Optional
from pydantic import BaseModel


class ScanFolderRequest(BaseModel):
    folder_path: str


class FileInfo(BaseModel):
    filename: str
    path: str
    columns: List[str]
    row_count: int


class ScanFolderResponse(BaseModel):
    files: List[FileInfo]
    detected_roles: Dict[str, str]


class ColumnMap(BaseModel):
    frequency: str
    real_z: str
    imag_z: str
    negate_imag: bool = False
    characterization: Dict[str, str]  # label -> column_name


class CircuitConfig(BaseModel):
    circuit_string: str
    param_names: List[str]
    initial_guess: List[float]
    lower_bounds: List[Optional[float]]  # None → 0 for lower
    upper_bounds: List[Optional[float]]  # None → inf for upper


class FitRequest(BaseModel):
    files: List[FileInfo]
    column_map: ColumnMap
    circuit_config: CircuitConfig
    fit_timeout: float = 60.0


class FitResult(BaseModel):
    filename: str
    success: bool
    error: Optional[str] = None
    parameters: Dict[str, float] = {}
    confidence: Dict[str, float] = {}
    z_real_fit: List[float] = []
    z_imag_fit: List[float] = []
    z_real_data: List[float] = []
    z_imag_data: List[float] = []
    characterization: Dict[str, float] = {}
    residual: Optional[float] = None


class ParseCircuitRequest(BaseModel):
    circuit_string: str
