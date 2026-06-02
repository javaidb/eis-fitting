# EIS Fitting — Discovery Guide

A plain-language tour of Electrochemical Impedance Spectroscopy: what the raw numbers mean, how they get turned into DRT plots and circuit fits, and exactly which lines of code do each step.

---

## 1. What is EIS? (The five-sentence version)

When you poke a battery or electrochemical cell with a tiny AC voltage at many different frequencies and record the resulting current, you can calculate how much the cell "resists" at each frequency. That frequency-dependent resistance is called **impedance**, and it has a real part (pure resistance) and an imaginary part (energy storage / release). Plotting real vs imaginary impedance at every frequency gives a shape called a **Nyquist plot**, which looks like one or more arcs or semicircles. Each arc corresponds to a physical process happening inside the cell — charge transfer at an electrode surface, ion diffusion through a film, bulk electrolyte resistance, etc. EIS lets you separate and quantify all those processes simultaneously, without destructively opening the cell.

---

## 2. The Raw Data: what a CSV contains

Every CSV file produced by an EIS instrument has (at minimum) three columns:

| Column | Symbol | What it means |
|--------|--------|---------------|
| Frequency | f (Hz) | How fast the AC signal oscillates — typically 0.01 Hz to 1 MHz |
| Real impedance | Z' (Ω) | The in-phase (resistive) part of the impedance |
| Imaginary impedance | Z'' (Ω) | The 90°-out-of-phase (capacitive / inductive) part |

Instruments differ on naming (some call it `Zreal`, others `Z.re`, others `impedance_real`). The app auto-detects them.

**Code:** [`backend/file_handler.py:11-18`](backend/file_handler.py#L11-L18) — regex patterns that recognise every common column-name variant.

```
"frequency":   re.compile(r"freq|hz|frequency", re.IGNORECASE),
"real_z":      re.compile(r"zreal|z_re|...", re.IGNORECASE),
"imag_z":      re.compile(r"zimag|z_im|...", re.IGNORECASE),
```

---

## 3. Loading and Cleaning the Data

### Theory

Raw instrument output sometimes has sign conventions that differ between vendors: some store −Z'' (already positive), others store +Z'' (negative for a capacitive arc). An inductive artefact at high frequency causes a few points to have Z'' > 0 (the Nyquist arc dips *below* the real axis). Those points are physically meaningless for the analysis and should be discarded.

### Code

[`backend/file_handler.py:73-107`](backend/file_handler.py#L73-L107) — `load_eis_data` does all of this:

1. **Read columns** (`lines 79-81`): pulls the three columns the user mapped in the UI.
2. **Negate imag if needed** (`lines 83-84`): if the user ticked "negate imaginary", flip the sign so the capacitive arc sits above the real axis.
3. **Assemble complex Z** (`line 86`): `Z = z_real + 1j * z_imag` — Python complex number, one value per frequency point.
4. **Drop bad points** (`lines 89-91`): removes any row where frequency ≤ 0 (instrument noise) or Z.imag > 0 (inductive artefact).
5. **Extract characterization values** (`lines 94-99`): reads extra columns like temperature or SOC so results can be grouped later.

---

## 4. The Nyquist Plot

### Theory

On a Nyquist plot the x-axis is Z' (real) and the y-axis is −Z'' (imaginary, flipped so the arcs point upward). Each frequency is one point. High frequencies appear on the left; low frequencies on the right. A perfect semicircle corresponds to a single RC relaxation process (one resistor in parallel with one capacitor). Real cells have multiple overlapping arcs because many processes are happening simultaneously.

### Code

The Nyquist is drawn in the fitting-runner modal:

[`static/js/views/fitting-runner.js:425-456`](static/js/views/fitting-runner.js#L425-L456) — `plotNyquist`:
- Data trace: `x = z_real_data`, `y = z_imag_data.map(v => -v)` (flipped)
- Fit trace: same for the model-predicted curve

---

## 5. DRT — Distribution of Relaxation Times

### 5a. Theory

The Nyquist plot shows *what* the data looks like but it is hard to count overlapping arcs by eye. **DRT** is a mathematical technique that asks: "what distribution of time constants would produce exactly this Nyquist shape?"

Every electrochemical process has a characteristic **relaxation time τ** (tau, in seconds). Fast processes (bulk resistance) have very small τ (microseconds). Slow processes (diffusion through a thick film) have large τ (seconds). The DRT function **γ(τ)** tells you how much of the total impedance belongs to each time-scale.

**Why imaginary impedance?** The imaginary part of impedance is where the time-constant information lives. For a simple RC circuit the imaginary part is:

```
Z''(ω) = -R · (ωτ) / (1 + (ωτ)²)      where ω = 2πf, τ = RC
```

This is peaked at ω = 1/τ, so it directly encodes the relaxation time. The DRT algorithm inverts this relationship across the whole spectrum at once.

**What is the kernel?** The equation relating γ(τ) to the measured Z'' is an integral:

```
Z''(ω) = ∫ γ(τ) · (ωτ)/(1+(ωτ)²) dln τ
```

Given the measured Z'' at N frequencies, we want to find γ at M time-constant grid points. That's an **inverse problem** — we have to go backwards from the measurements to the unknown distribution.

**Why regularisation?** Inverse problems are ill-conditioned: tiny measurement noise can produce wildly oscillating solutions. **Tikhonov regularisation** adds a penalty for solutions that wiggle too much (specifically, it penalises large second derivatives of γ). The parameter **λ** (lambda) controls this trade-off: large λ gives a smooth but possibly smeared-out distribution; small λ follows the data more closely but can become noisy.

### 5b. Code — step by step

[`backend/drt.py:14-53`](backend/drt.py#L14-L53) — `compute_drt`:

**Step 1 — Build the frequency–time grid** (`lines 20-28`):
```python
omega = 2 * np.pi * frequencies           # angular frequency ω = 2πf
log_tau = np.linspace(log_tau_min, log_tau_max, n_tau)   # 100-point log grid
tau = 10.0 ** log_tau
```
The τ grid spans one decade beyond the measured frequency range so the fit is not artificially clamped at the edges.

**Step 2 — Build the kernel matrix K** (`lines 31-32`):
```python
wt = omega[:, None] * tau[None, :]        # ω·τ, shape (N_freq, N_tau)
K = wt / (1.0 + wt ** 2) * np.log(10) * d_log10
```
Each element `K[k,j]` is the contribution of the j-th time constant to the k-th frequency measurement. The `ln(10) * Δ(log₁₀τ)` factor converts the integral from log-τ to the discrete sum.

**Step 3 — Build the regularisation matrix L** (`lines 35-39`):
L is a second-difference matrix. Multiplying γ by L gives the curvature of γ. Penalising L·γ keeps γ smooth.

**Step 4 — Solve the regularised least-squares problem** (`lines 42-45`):
```python
A = K.T @ K + lambda_reg * (L.T @ L)
b = K.T @ z_imag
gamma = np.linalg.solve(A, b)
gamma = np.maximum(gamma, 0.0)            # physical: γ must be non-negative
```
This is the core computation. It is a single dense linear solve — fast even for N=100 grid points.

**Step 5 — Find peaks** (`lines 47-51`):
After computing γ, the code fits Gaussians to the prominent peaks using `scipy.optimize.curve_fit`. Each Gaussian gives a centre τ, a width σ, and a quality score R².

[`backend/drt.py:56-122`](backend/drt.py#L56-L122) — `_fit_gaussian_peaks`:
- Uses `scipy.signal.find_peaks` to locate candidate peaks (`lines 62-67`)
- Fits all peaks simultaneously as a sum of Gaussians (`lines 72-87`)
- Scores each peak by how well its Gaussian covers the local DRT data, normalized so a perfect fit → R²=1 (`lines 104-111`)

### 5c. What the DRT plot shows

The horizontal axis is log₁₀(τ), so each decade of time spans the same width. The vertical axis γ(τ) is a "spectral density of resistance" — peaks mean there is a process at that time scale. Dashed coloured lines show the fitted Gaussians. The app buckets peaks into four physical categories:

| τ range | Suggested process |
|---------|------------------|
| < 5 ms | Bulk / ohmic resistance (R₀) |
| 5 ms – 100 ms | SEI (solid-electrolyte interphase) film |
| 100 ms – 1 s | Charge transfer at electrode surface |
| > 1 s | Solid-state diffusion |

**Code:** [`static/js/views/drt-viewer.js:11-23`](static/js/views/drt-viewer.js#L11-L23) — `MECHANISMS` array and `categorizePeak`.

### 5d. Circuit suggestion from DRT

Once the DRT peaks are categorised the app proposes an equivalent circuit string automatically:

[`static/js/views/drt-viewer.js:41-55`](static/js/views/drt-viewer.js#L41-L55) — `suggestCircuit`:
- If any peak falls in the SEI bucket → add a `p(R,CPE)` branch
- If any peak falls in the charge-transfer bucket → add another `p(R,CPE)` branch
- If any peak falls in the diffusion bucket → add a `Wo` (finite-length Warburg) element

The output is a circuit string like `R0-p(R1,CPE0)-p(R2,CPE1)-Wo0` that you can copy directly into the circuit builder.

---

## 6. Circuit Fitting

### 6a. Theory

Once you know roughly which processes are present, the next step is to fit a **parametric equivalent-circuit model** to the data. An equivalent circuit is an arrangement of idealised electrical components (resistors, capacitors, etc.) whose impedance as a function of frequency matches the measured data.

**Why does a resistor in parallel with a capacitor produce a semicircle?**  
The impedance of a parallel RC combination is:
```
Z(ω) = R / (1 + jωRC)
```
The real part is `R/(1+(ωRC)²)` and the imaginary part is `−R·ωRC/(1+(ωRC)²)`. Plotting one against the other traces a perfect semicircle of radius R/2. Each physical process in the cell behaves like this, so the Nyquist plot is a superposition of semicircles.

**What is optimisation doing?** Given a circuit topology (which components, how they are connected), the optimiser searches for the set of parameter values (R₁, C₁, R₂, Q₂, α₂, …) that minimises the difference between the model-predicted impedance and the measured impedance at every frequency. This is a non-linear least-squares problem solved by SciPy's `curve_fit` under the hood via the `impedance.py` library.

**Bounds:** Physical parameters cannot be negative (a negative resistance makes no sense). The user sets lower and upper bounds in the Bounds Editor step. The optimiser is constrained to search only in that region.

**Residual:** After fitting, the app reports a **mean relative error**:
```
residual = mean(|Z_data - Z_fit| / |Z_data|)
```
A residual below ~5% is considered good.

### 6b. The circuit string format

Circuits are described in a text notation from the `impedance.py` library:
- `R0-C0` means R₀ in series with C₀
- `p(R1,C1)` means R₁ in parallel with C₁
- `R0-p(R1,CPE0)-Wo0` means R₀ in series with a parallel RC, then a Warburg in series

**Code that parses this into a visual tree:** [`static/js/views/circuit-builder.js:47-87`](static/js/views/circuit-builder.js#L47-L87) — `stringToTree` (recursive descent parser).  
**Code that serialises the visual tree back to a string:** [`static/js/views/circuit-builder.js:35-45`](static/js/views/circuit-builder.js#L35-L45) — `treeToString`.

### 6c. Code — step by step

[`backend/fitting.py:28-76`](backend/fitting.py#L28-L76) — `fit_single`:

**Step 1 — Build the circuit object** (`lines 39-40`):
```python
circuit = CustomCircuit(
    circuit=circuit_config.circuit_string,
    initial_guess=circuit_config.initial_guess,
)
```
`impedance.py`'s `CustomCircuit` knows the impedance formula for every element and composes them according to the topology string.

**Step 2 — Fit** (`line 43`):
```python
circuit.fit(frequencies, Z, bounds=(lower, upper))
```
Internally this calls `scipy.optimize.curve_fit` with the composed impedance function. It iterates until the predicted Z matches the measured Z as closely as possible within the given bounds.

**Step 3 — Predict** (`line 45`):
```python
Z_fit = circuit.predict(frequencies)
```
Evaluates the fitted model at the original frequencies, producing a smooth complex curve.

**Step 4 — Compute residual** (`lines 52`):
```python
residual = float(np.mean(np.abs(Z - Z_fit) / (np.abs(Z) + 1e-12)))
```

**Step 5 — Confidence intervals** (`lines 49-51`): `impedance.py` exposes `circuit.conf_` — the 1σ parameter uncertainties derived from the covariance matrix of the fit. These are shown as error bars in the Trends view.

### 6d. Streaming results

Both DRT and fitting process many files in sequence and stream each result back as a **Server-Sent Event** so the UI updates file-by-file rather than waiting for all files to finish.

- Backend streams: [`backend/fitting.py:79-102`](backend/fitting.py#L79-L102) — `fit_batch_stream` / [`backend/drt.py:125-146`](backend/drt.py#L125-L146) — `drt_batch_stream`
- Frontend consumes: [`static/js/api.js:73-104`](static/js/api.js#L73-L104) — `streamFitting` / `streamDRT` (async generators over the SSE stream)

---

## 7. Trends

### Theory

After fitting every file in your dataset you have a table: each row is one measurement, each column is a fitted parameter value (R₀, R₁, C₁, …). The interesting question is: **how do those parameters change with temperature, state-of-charge, cycle number, or any other condition you varied?** That is what the Trends view shows.

### Code

[`static/js/views/trends.js:218-359`](static/js/views/trends.js#L218-L359) — `plotTrend`:

- Groups all successful fit results by the "Group by" characterization variable (e.g. battery ID)
- For each group, bins the parameter values by the X-axis variable (e.g. temperature)
- Plots either scatter (mean line) or box-and-whisker (distribution) depending on the toggle
- Optionally overlays ±1σ confidence bars from the fit uncertainty

The Y-axis is auto-scaled with physical units (R in mΩ, C in F, τ in seconds, etc.) so the numbers are always human-readable.

---

## 8. End-to-end data flow summary

```
CSV files on disk
        │
        ▼
file_handler.py: load_eis_data()
  • read freq, Z_real, Z_imag
  • negate / clean
  • assemble Z = Z_real + j·Z_imag
        │
        ├──────────────────────────────────────────┐
        │ DRT path                                 │ Circuit fit path
        ▼                                          ▼
drt.py: compute_drt()                  fitting.py: fit_single()
  • build ω, τ grid                      • CustomCircuit(string)
  • build kernel matrix K                • circuit.fit(freq, Z)
  • Tikhonov solve → γ(τ)               • circuit.predict(freq)
  • find_peaks + Gaussian fit            • compute residual
  • return log_tau, gamma, peaks         • return Z_fit, params, conf
        │                                          │
        ▼                                          ▼
drt-viewer.js                          fitting-runner.js
  • plotDRT (γ vs log τ)                  • plotNyquist / Bode / Residuals
  • plotExplorer (peaks vs condition)     • tile grid (residual colour)
  • suggestCircuit → circuit string       │
                                          ▼
                                       trends.js
                                         • plotTrend (param vs condition)
                                         • box/whisker, confidence bars
                                         • exportCSV
```

---

## 9. Component glossary

| Symbol | Name | Physical meaning |
|--------|------|-----------------|
| R | Resistor | Pure ohmic resistance (electrolyte, contact, current collector) |
| C | Capacitor | Ideal double-layer capacitance |
| L | Inductor | Cable/connection inductance (high-frequency artefact) |
| CPE | Constant Phase Element | Non-ideal capacitor; α=1 recovers C, α=0.5 recovers Warburg. Used because real electrode surfaces are rough/porous |
| W | Warburg (semi-infinite) | Diffusion into a half-space — impedance grows as 1/√(jω) |
| Wo | Warburg (open / reflective) | Finite-layer diffusion with a blocking boundary (ion can't escape) |
| Ws | Warburg (short / transmissive) | Finite-layer diffusion with a permeable boundary (ion passes through) |

---

## 10. The λ (lambda) regularisation knob

Lambda is the only non-trivial user-tunable parameter in the DRT step. Rule of thumb:

- **λ too large (e.g. 1.0):** γ is over-smoothed, peaks merge together or disappear entirely.
- **λ too small (e.g. 1e-7):** γ shows many spurious wiggles that are noise artefacts.
- **Good starting point: 1e-3** (the default). Decrease to 1e-4 or 1e-5 if you know your data is very clean and you expect closely spaced peaks.

The slider lives in the DRT view UI; the value is passed through to [`backend/drt.py:18`](backend/drt.py#L18) as `lambda_reg`.
