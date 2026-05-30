"""
Generate synthetic EIS data files for testing.

Circuit model: R0-p(R1,C1)-W0
  R0  = ohmic/electrolyte resistance
  R1  = charge-transfer resistance (in parallel with C1)
  C1  = double-layer capacitance
  W0  = semi-infinite Warburg (diffusion)

20 files: 5 temperatures × 4 voltages
Columns: freq_Hz, Zreal_ohm, Zimag_ohm, temperature_C, voltage_V
"""

import os
import numpy as np
import pandas as pd

# ── Output folder ───────────────────────────────────────────────
OUT_DIR = os.path.join(os.path.dirname(__file__), "data", "sample_eis")
os.makedirs(OUT_DIR, exist_ok=True)

# ── Frequency range ─────────────────────────────────────────────
FREQS = np.logspace(-2, 5, 40)   # 0.01 Hz → 100 kHz, 40 points

# ── Conditions ──────────────────────────────────────────────────
TEMPERATURES = [5.0, 15.0, 25.0, 35.0, 45.0]  # °C
VOLTAGES     = [3.5, 3.7, 3.9, 4.1]            # V

# ── Parameter models (physically motivated) ─────────────────────
def R0(T):
    """Electrolyte resistance — decreases with temperature (Arrhenius ionic conductivity)."""
    return 0.008 / (1 + 0.025 * (T - 25))

def R1(T, V):
    """Charge-transfer resistance — Arrhenius T-dep + parabolic SOC/V dependence."""
    return 0.06 * np.exp(-0.055 * (T - 25)) * (1 + 1.2 * (V - 3.8) ** 2)

def C1(_T, _V):
    """Double-layer capacitance — relatively constant."""
    return 0.08

def sigma(T):
    """Warburg coefficient — increases at lower T (slower diffusion)."""
    return 4.0 * np.exp(-0.045 * (T - 25))


# ── Impedance calculation ────────────────────────────────────────
def impedance(freq, r0, r1, c1, sig):
    omega = 2 * np.pi * freq

    z_r0 = r0                                        # series resistor
    z_c1 = 1 / (1j * omega * c1)                    # capacitor
    z_rc = r1 * z_c1 / (r1 + z_c1)                 # parallel R1‖C1
    z_w  = sig * (1 - 1j) / np.sqrt(omega)          # semi-inf Warburg

    return z_r0 + z_rc + z_w


# ── Generate files ───────────────────────────────────────────────
rng = np.random.default_rng(42)

for T in TEMPERATURES:
    for V in VOLTAGES:
        Z = impedance(FREQS, R0(T), R1(T, V), C1(T, V), sigma(T))

        # Add ~1% relative Gaussian noise (real and imag independently)
        noise_scale = 0.01
        Z_re = Z.real + rng.normal(0, noise_scale * np.abs(Z.real))
        Z_im = Z.imag + rng.normal(0, noise_scale * np.abs(Z.imag))

        df = pd.DataFrame({
            "freq_Hz":       FREQS,
            "Zreal_ohm":     Z_re,
            "Zimag_ohm":     Z_im,
            "temperature_C": T,
            "voltage_V":     V,
        })

        fname = f"eis_T{int(T):02d}C_V{str(V).replace('.', 'p')}V.csv"
        df.to_csv(os.path.join(OUT_DIR, fname), index=False, float_format="%.6g")
        print(f"  {fname}   R0={R0(T):.4f}  R1={R1(T,V):.4f}  sig={sigma(T):.3f}")

print(f"\n{len(TEMPERATURES) * len(VOLTAGES)} files written to {OUT_DIR}")
