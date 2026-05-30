# Mendeley EIS Dataset — Reformatted

Data source: **https://data.mendeley.com/datasets/mbv3bx847g/3**

This folder contains EIS spectra from the above public Mendeley dataset, reformatted into the directory structure expected by this tool.

## Structure

```
mendeley_sample_01_reformatted/
├── battery_02/   60 spectra  (temp codes 4–9 × SOC 10–100 %)
├── battery_03/   60 spectra
├── battery_05/   60 spectra
└── battery_06/   60 spectra
```

One CSV per unique (temp\_code, SOC) condition. Battery cell identity is encoded in the subfolder name (trailing number).

## Column reference

| Column | Description |
|--------|-------------|
| `frequency_hz` | Frequency (Hz) |
| `impedance_real` | Real part of Z (Ω) |
| `impedance_imag` | Imaginary part of Z (Ω) |
| `temp_code` | Integer temperature code as used in the original dataset |
| `soc` | State of charge (%) |

`battery_id` is not a column — it is derived automatically from the subfolder name by the file handler.

## Reformatting script

`data/reformat_mendeley.py` reproduces this folder from the raw source files in `data/mendeley_sample_01/`.
