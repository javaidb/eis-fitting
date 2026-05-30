# EIS Fitting

A local browser-based tool for batch electrochemical impedance spectroscopy (EIS) fitting. Load a folder of CSV files, map your column names, build an equivalent circuit via drag-and-drop, set parameter bounds, fit everything in one click, and visualise how each extracted parameter trends across temperature, voltage, or any other characterisation variable.

Built on top of [impedance.py](https://impedancepy.readthedocs.io/) with a FastAPI backend and a vanilla JS/HTML frontend — no build tools required.

---

## Features

- **Folder scan** — point the app at a directory; it reads every CSV and auto-detects which columns are frequency, real Z, imaginary Z, temperature, voltage, etc.
- **Column mapping wizard** — confirm or override the auto-detected roles; add any number of characterisation variables that vary between files
- **Drag-and-drop circuit builder** — palette of R, C, L, CPE, W, Wo, Ws elements; drag onto the SVG canvas to build series/parallel circuits; undo/redo; direct circuit-string editing with live SVG preview
- **Parameter bounds editor** — per-parameter initial guess, minimum, and maximum; "Suggest Defaults" fills physically realistic starting values
- **Batch fitting with live progress** — fits every file in sequence; results stream back via SSE so Nyquist plot cards appear as each fit completes; cards are colour-coded by residual quality
- **Trend charts** — Plotly scatter plots of any fitted parameter vs any characterisation variable, with optional colour grouping by a second variable and confidence-interval error bars; one-click CSV export

---

## Quick start

### 1. Clone and create a virtual environment

```bash
git clone https://github.com/javaidb/eis-fitting.git
cd eis-fitting
python -m venv .venv
```

Activate it:

```bash
# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Run the server

```bash
uvicorn app:app --reload
```

Open **http://localhost:8000** in your browser.

---

## Workflow

The app guides you through six steps in order. Completed steps stay accessible so you can go back and adjust anything.

### Step 1 — Load Files

Enter an absolute folder path or click **Browse…** to open a native OS folder picker. The app scans for CSV files and shows a preview of each file's columns and row count.

### Step 2 — Map Columns

Assign which CSV columns correspond to:

| Role | Used for |
|------|----------|
| Frequency | Impedance analysis |
| Real impedance Z′ | Impedance analysis |
| Imaginary impedance Z″ | Impedance analysis |
| Temperature, Voltage, … | Characterisation / trend axes |

A *Negate Z″* toggle handles datasets where the imaginary part is stored as a positive number. Column roles are auto-detected from common naming conventions (`freq`, `Zreal`, `Zimag`, `temp`, `voltage`, etc.).

### Step 3 — Build Circuit

Construct your equivalent circuit on the SVG canvas:

- **Click** a palette item to append it to the end of the circuit
- **Drag** a palette item and drop it between components (insert in series) or on top of a component (create a parallel branch)
- **Click** a placed component to select it; a delete button appears
- **Click** a parallel group's **+ branch** button to add another branch
- Edit the circuit string directly in the text box (e.g. `R0-p(R1,C1)-W0`) and press Enter — the SVG updates instantly
- **Undo / Redo / Clear** buttons are available at all times

#### Available elements

| Symbol | Name | Parameters |
|--------|------|------------|
| R | Resistor | R (Ω) |
| C | Capacitor | C (F) |
| L | Inductor | L (H) |
| CPE | Constant Phase Element | Q, α |
| W | Warburg (semi-infinite) | σ |
| Wo | Warburg (open / reflective) | R, τ |
| Ws | Warburg (short / transmissive) | R, τ |

### Step 4 — Set Bounds

A table lists every parameter in the circuit (names taken directly from impedance.py). For each one, set an initial guess, lower bound, and upper bound. Click **Suggest Defaults** to fill reasonable starting values based on element type.

### Step 5 — Fit

Click **Run Fitting**. Each file is fitted in sequence using `scipy.optimize.least_squares` (via impedance.py). Results stream back live:

- Progress bar and current filename update in real time
- A Nyquist plot card appears for each file as it completes, overlaying the experimental data (markers) with the fitted curve (line)
- Cards are highlighted green (residual < 5 %) or red (poor fit or error)
- Fitted parameter values are shown below each plot

### Step 6 — Trends

After all fits complete, explore how the extracted parameters vary across your characterisation space:

- Choose any characterisation variable (temperature, voltage, SOC, …) as the X axis — battery ID is always used as the colour grouping so different cells are distinguishable at a glance
- Multi-select any combination of fitted parameters for the Y axis
- When multiple spectra share the same X value (e.g. repeated measurements), the data is shown as **box-and-whisker plots** with a dashed mean trend line; toggle to **mean-only** view using the checkbox in the controls bar
- Axis labels include units automatically: R elements display in mΩ, C in F, temperature in °C, SOC in %, voltage in V — overridable per variable in the column mapper
- **Export CSV** downloads the full results table (filename, all characterisation values, all parameter values)

---

## Data format requirements

### Directory structure

Organise your data with **one subfolder per battery cell**. Inside each subfolder, place **one CSV file per unique measurement condition** (temperature × SOC × voltage, etc.) — no further nesting.

```
my_dataset/
├── cell_01/
│   ├── T25C_V3p7V.csv
│   ├── T25C_V3p9V.csv
│   └── ...
├── cell_02/
│   ├── T25C_V3p7V.csv
│   └── ...
└── cell_03/
    └── ...
```

Point the app at the **dataset root** (`my_dataset/`) and it will scan all battery subfolders automatically.

> **Battery ID** is derived automatically from the trailing number in the subfolder name — `cell_01` → 1, `battery_03` → 3. You do not need a `battery_id` column in your CSVs.

---

### CSV columns

Each CSV must contain exactly one EIS spectrum (rows = frequency points).

#### Required columns

| Column | Description |
|--------|-------------|
| Frequency | Measurement frequency in Hz — must be > 0 |
| Real impedance Z′ | Real part of complex impedance (Ω) |
| Imaginary impedance Z″ | Imaginary part of complex impedance (Ω) |

Column names are matched by pattern, not exact string, so `freq_Hz`, `frequency`, `Frequency (Hz)` all work for frequency; `Zreal`, `impedance_real`, `Re(Z)` all work for real impedance, and so on.

#### Condition columns (optional but recommended)

Any additional columns that describe the measurement condition — temperature, state of charge, voltage, cycle number, etc. — can be mapped in Step 2 as characterisation variables. Their values must be **constant within a single file** (every row the same) since only the first row's value is read.

```
frequency_hz,impedance_real,impedance_imag,temperature_c,soc
0.05,0.1109,-0.0054,25,100
0.10,0.1097,-0.0036,25,100
...
1000.0,0.0796,-0.0040,25,100
```

#### Auto-detected column roles

The app auto-detects the following roles when you load a folder:

| Role | Matched patterns (case-insensitive) |
|------|--------------------------------------|
| Frequency | `freq`, `hz`, `frequency` |
| Real Z | `zreal`, `z_re`, `impedance_real`, `real` |
| Imaginary Z | `zimag`, `z_im`, `impedance_imag`, `imag` |
| Temperature | `temp`, `celsius`, `kelvin`, `degc` |
| Voltage | `volt`, `voltage`, `_v`, `^v` |
| SOC | `soc`, `state of charge` |

If your column names aren't recognised, assign them manually in the column mapper (Step 2).

#### Negate Z″

If your dataset stores the imaginary part as a positive number (i.e. −Z″ is stored), enable the **Negate Z″** toggle in the column mapper. The app will flip the sign before fitting.

---

### Included sample data

`data/sample_eis/cell_01/` contains 20 ready-to-use spectra (5 temperatures × 4 voltages).

| Column | Unit |
|--------|------|
| `frequency_hz` | Hz |
| `impedance_real` | Ω |
| `impedance_imag` | Ω |
| `temperature_c` | °C |
| `voltage_v` | V |

Use `data/sample_eis` as the folder path in Step 1 and `R0-p(R1,C1)-W0` as the circuit in Step 3 to walk through the full workflow end-to-end.

`data/mendeley_sample_01_reformatted/` contains real battery EIS data from a public Mendeley dataset, reformatted into the required directory structure (4 battery cells, 60 spectra each across temperatures 3–9 and SOC 10–100 %).

---

## Project structure

```
eis-fitting/
├── app.py                    # FastAPI server and API routes
├── requirements.txt
├── generate_samples.py       # Synthetic EIS data generator
├── backend/
│   ├── models.py             # Pydantic request/response models
│   ├── file_handler.py       # CSV scanning, column heuristics, data loading
│   └── fitting.py            # impedance.py wrapper, batch fitting, SSE stream
└── static/
    ├── index.html            # SPA shell
    ├── css/style.css
    └── js/
        ├── state.js          # Reactive store (localStorage persistence)
        ├── api.js            # fetch wrappers + SSE async generator
        ├── main.js           # Step router
        └── views/
            ├── file-loader.js
            ├── column-mapper.js
            ├── circuit-builder.js
            ├── bounds-editor.js
            ├── fitting-runner.js
            └── trends.js
```

---

## Dependencies

| Package | Role |
|---------|------|
| [fastapi](https://fastapi.tiangolo.com/) | HTTP server and API |
| [uvicorn](https://www.uvicorn.org/) | ASGI server |
| [impedance](https://impedancepy.readthedocs.io/) | EIS circuit fitting |
| [pandas](https://pandas.pydata.org/) | CSV loading |
| [numpy](https://numpy.org/) | Array operations |
| [scipy](https://scipy.org/) | Optimisation (used internally by impedance.py) |
| [Plotly.js](https://plotly.com/javascript/) *(CDN)* | Interactive charts in the browser |
