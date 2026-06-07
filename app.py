from __future__ import annotations
import asyncio
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend.drt import drt_batch_stream
from backend.file_handler import characterize_files, scan_folder
from backend.fitting import compute_fit_envelope, fit_batch_stream, get_param_names
from backend.kk import kk_batch_stream
from backend.models import CharacterizeRequest, DRTRequest, EnvelopeRequest, EnvelopeResponse, FitRequest, FreqRangeRequest, KKRequest, ParseCircuitRequest, ScanFolderRequest

app = FastAPI(title="EIS Fitting")

CIRCUIT_ELEMENTS = [
    {"symbol": "R",   "name": "Resistor",                  "n_params": 1, "color": "#e05c5c",
     "param_labels": ["R"],    "param_units": ["Ω"],
     "description": "Ideal ohmic resistance"},
    {"symbol": "C",   "name": "Capacitor",                 "n_params": 1, "color": "#4a9ade",
     "param_labels": ["C"],    "param_units": ["F"],
     "description": "Ideal capacitor"},
    {"symbol": "L",   "name": "Inductor",                  "n_params": 1, "color": "#9b59b6",
     "param_labels": ["L"],    "param_units": ["H"],
     "description": "Ideal inductor"},
    {"symbol": "CPE", "name": "Const. Phase Element",      "n_params": 2, "color": "#e67e22",
     "param_labels": ["Q", "α"], "param_units": ["F·s^(α-1)", ""],
     "description": "Non-ideal capacitor; α=1 → ideal C, α=0.5 → Warburg"},
    {"symbol": "W",   "name": "Warburg (semi-∞)",          "n_params": 1, "color": "#27ae60",
     "param_labels": ["σ"],    "param_units": ["Ω·s⁻⁰·⁵"],
     "description": "Semi-infinite linear diffusion"},
    {"symbol": "Wo",  "name": "Warburg (open)",            "n_params": 2, "color": "#1abc9c",
     "param_labels": ["R", "τ"], "param_units": ["Ω", "s"],
     "description": "Finite-length diffusion, reflective boundary"},
    {"symbol": "Ws",  "name": "Warburg (short)",           "n_params": 2, "color": "#16a085",
     "param_labels": ["R", "τ"], "param_units": ["Ω", "s"],
     "description": "Finite-length diffusion, transmissive boundary"},
]

PARAM_DEFAULTS = {
    "R":   {"initial": 0.01,  "lower": 0.0, "upper": None},
    "C":   {"initial": 1e-6,  "lower": 0.0, "upper": None},
    "L":   {"initial": 1e-7,  "lower": 0.0, "upper": None},
    "CPE_Q": {"initial": 1e-5, "lower": 0.0, "upper": None},
    "CPE_a": {"initial": 0.8,  "lower": 0.0, "upper": 1.0},
    "W":   {"initial": 100.0, "lower": 0.0, "upper": None},
    "Wo_R": {"initial": 100.0, "lower": 0.0, "upper": None},
    "Wo_t": {"initial": 1.0,   "lower": 0.0, "upper": None},
    "Ws_R": {"initial": 100.0, "lower": 0.0, "upper": None},
    "Ws_t": {"initial": 1.0,   "lower": 0.0, "upper": None},
}


@app.get("/api/pick-folder")
def api_pick_folder():
    """Open a native OS folder-picker dialog and return the chosen path."""
    import tkinter as tk
    from tkinter import filedialog
    from pathlib import Path
    root = tk.Tk()
    root.withdraw()
    root.wm_attributes("-topmost", True)
    folder = filedialog.askdirectory(parent=root, title="Select EIS data folder")
    root.destroy()
    # Resolve to canonical absolute path with OS-native separators
    if folder:
        folder = str(Path(folder).resolve())
    return {"path": folder or ""}


@app.get("/")
async def serve_index():
    return FileResponse("static/index.html")


@app.post("/api/scan-folder")
async def api_scan_folder(request: ScanFolderRequest):
    try:
        files, detected_roles = scan_folder(request.folder_path)
        return {"files": [f.model_dump() for f in files], "detected_roles": detected_roles}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/elements")
async def api_elements():
    return CIRCUIT_ELEMENTS


@app.get("/api/param-defaults")
async def api_param_defaults():
    return PARAM_DEFAULTS


@app.post("/api/parse-circuit")
async def api_parse_circuit(request: ParseCircuitRequest):
    try:
        names, units = get_param_names(request.circuit_string)
        return {"param_names": names, "param_units": units}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid circuit: {exc}")


@app.post("/api/freq-range")
async def api_freq_range(request: FreqRangeRequest):
    import pandas as pd
    try:
        df = pd.read_csv(request.path, usecols=[request.frequency_column])
        freqs = pd.to_numeric(df[request.frequency_column], errors="coerce").dropna()
        if freqs.empty:
            raise HTTPException(status_code=400, detail="No valid frequency values found")
        return {"freq_min": float(freqs.min()), "freq_max": float(freqs.max())}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/characterize")
async def api_characterize(request: CharacterizeRequest):
    try:
        return characterize_files(request.files, request.column_map)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/fit-envelope")
async def api_fit_envelope(request: EnvelopeRequest):
    try:
        frequencies = np.array(request.frequencies)
        z_real_upper, z_real_lower, z_imag_upper, z_imag_lower = await asyncio.to_thread(
            compute_fit_envelope,
            request.circuit_string,
            request.parameters,
            request.confidence,
            frequencies,
            request.n_samples,
        )
        return EnvelopeResponse(
            z_real_upper=z_real_upper.tolist(),
            z_real_lower=z_real_lower.tolist(),
            z_imag_upper=z_imag_upper.tolist(),
            z_imag_lower=z_imag_lower.tolist(),
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/fit")
async def api_fit(request: FitRequest):
    async def stream():
        async for chunk in fit_batch_stream(request):
            yield chunk

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/drt")
async def api_drt(request: DRTRequest):
    async def stream():
        async for chunk in drt_batch_stream(request):
            yield chunk

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/kk")
async def api_kk(request: KKRequest):
    async def stream():
        async for chunk in kk_batch_stream(request):
            yield chunk

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app.mount("/", StaticFiles(directory="static", html=True), name="static")
