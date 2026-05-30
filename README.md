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

- Choose any characterisation variable (temperature, voltage, …) as the X axis
- Multi-select any combination of fitted parameters for the Y axis
- Optionally group by a second characterisation variable, displayed as colour-coded series
- Error bars reflect the confidence intervals returned by the fitting
- **Export CSV** downloads the full results table (filename, all characterisation values, all parameter values)

---

## CSV format

Any CSV with consistent column headers works. A typical file looks like:

```
freq_Hz,Zreal_ohm,Zimag_ohm,temperature_C,voltage_V
100000,0.00812,-0.00031,25,3.9
...
0.01,15.89,-15.65,25,3.9
```

Characterisation values (temperature, voltage, etc.) are read from the first data row of each file, so they should be constant within a single EIS run.

### Generate sample data

The repository includes a script that produces 20 synthetic files (5 temperatures × 4 voltages) using a `R0-p(R1,C1)-W0` circuit with Arrhenius temperature dependence and a parabolic voltage dependence on R1:

```bash
python generate_samples.py
# writes to data/sample_eis/
```

Use `data/sample_eis` as the folder path in step 1 and `R0-p(R1,C1)-W0` as the circuit in step 3 to verify the full workflow end-to-end.

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
