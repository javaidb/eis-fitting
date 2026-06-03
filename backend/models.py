from __future__ import annotations
from typing import Dict, List, Optional, Union
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
    characterization: Dict[str, str]                        # label -> col_name (global fallback)
    per_battery_characterization: Dict[str, Dict[str, str]] = {}  # label -> {battery_id_str -> col_name}
    decimal_places: Dict[str, int] = {}                     # label -> decimals to round to


class CircuitConfig(BaseModel):
    circuit_string: str
    param_names: List[str]
    initial_guess: List[float]
    lower_bounds: List[Optional[float]]  # None → 0 for lower
    upper_bounds: List[Optional[float]]  # None → inf for upper


class OptimizeConfig(BaseModel):
    enabled: bool = False
    rc_min: int = 1       # minimum RC pair count to search
    rc_max: int = 5       # maximum RC pair count to search
    pair_types: List[str] = ["CPE"]  # "CPE" → p(R,CPE), "C" → p(R,C)
    criterion: str = "AIC"           # "AIC" or "BIC"
    n_restarts: int = 1  # random re-initialisations per variant; 1 = single fit


class VariantResult(BaseModel):
    circuit_string: str
    n_params: int
    residual: Optional[float] = None
    aic: Optional[float] = None
    bic: Optional[float] = None
    success: bool
    error: Optional[str] = None


class FitRequest(BaseModel):
    files: List[FileInfo]
    column_map: ColumnMap
    circuit_config: CircuitConfig
    fit_timeout: float = 60.0
    optimize_config: OptimizeConfig = OptimizeConfig()
    freq_min: Optional[float] = None  # Hz — None means no lower limit
    freq_max: Optional[float] = None  # Hz — None means no upper limit


class FitResult(BaseModel):
    filename: str
    path: str = ""
    success: bool
    error: Optional[str] = None
    parameters: Dict[str, float] = {}
    confidence: Dict[str, float] = {}
    frequencies: List[float] = []
    z_real_fit: List[float] = []
    z_imag_fit: List[float] = []
    z_real_data: List[float] = []
    z_imag_data: List[float] = []
    characterization: Dict[str, Union[float, str]] = {}
    residual: Optional[float] = None
    circuit_used: str = ""
    variants_tried: List[VariantResult] = []


class ParseCircuitRequest(BaseModel):
    circuit_string: str


class FreqRangeRequest(BaseModel):
    path: str
    frequency_column: str


class DRTRequest(BaseModel):
    files: List[FileInfo]
    column_map: ColumnMap
    lambda_reg: float = 1e-3


class DRTResult(BaseModel):
    filename: str = ""
    success: bool = False
    error: Optional[str] = None
    log_tau: List[float] = []
    gamma: List[float] = []
    peaks: List[dict] = []
    characterization: Dict[str, Union[float, str]] = {}
