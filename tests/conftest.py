import sys
from pathlib import Path

# Make the project root importable regardless of how pytest is invoked.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pytest


@pytest.fixture
def spectrum_2rc():
    """R0 + p(R1,C1) + p(R2,C2): τ1 = 1 ms, τ2 = 0.1 s, 0.2% multiplicative noise.

    True parameters: R0=0.010, R1=0.020, C1=0.05, R2=0.030, C2=3.33.
    """
    f = np.logspace(4, -2, 60)
    w = 2 * np.pi * f
    Z = 0.010 + 0.020 / (1 + 1j * w * 0.020 * 0.05) + 0.030 / (1 + 1j * w * 0.030 * 3.33)
    rng = np.random.default_rng(0)
    Zn = Z * (1 + 0.002 * (rng.standard_normal(len(f)) + 1j * rng.standard_normal(len(f))))
    return f, Zn


@pytest.fixture
def spectrum_1rc_dense():
    """Dense noise-free single arc: R0=0.010, R1=0.030, τ=15 ms."""
    f = np.logspace(5, -1, 120)
    w = 2 * np.pi * f
    Z = 0.010 + 0.030 / (1 + 1j * w * 0.030 * 0.5)
    return f, Z
