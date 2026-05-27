"""Hand-computed MAR21 worked examples — the failing-first oracle contract.

Each assertion uses values derived by hand below the test, so this file is
both the spec and the contract for `sbm.py`. Tolerances are 1e-12: these are
exact algebraic identities, not floating-point approximations.

Module under test: `sbm` (sibling sbm.py via conftest path injection).
"""
import math
import pytest

import sbm  # noqa: F401 — fails in RED until sbm.py exists


# ---- compute_kb_delta (GIRR Delta — weights per tenor, constant-rho) ---------

def test_kb_delta_two_rows_three_tenors():
    # rows -> sum_s per tenor: [1.5, 1.0, 5.0]
    # weights = [0.017, 0.017, 0.016]
    # WS = [0.0255, 0.017, 0.08]; SumWS = 0.1225; SumWS^2 = 0.00733925
    # K_b^2 = 0.00733925 + 0.99 * (0.1225^2 - 0.00733925) = 0.014929583
    rows = [
        {"sensitivity_type": "Delta", "risk_value": [1.0, 2.0, 3.0]},
        {"sensitivity_type": "Delta", "risk_value": [0.5, -1.0, 2.0]},
    ]
    weights = [0.017, 0.017, 0.016]
    res = sbm.compute_kb_delta(rows, weights, rho=0.99)
    assert res["count"] == 2
    assert res["S_b"] == pytest.approx(0.1225, abs=1e-12)
    assert res["K_b"] == pytest.approx(math.sqrt(0.014929583), abs=1e-9)


def test_kb_delta_ignores_non_delta_rows():
    rows = [
        {"sensitivity_type": "Delta", "risk_value": [1.0, 2.0]},
        {"sensitivity_type": "Vega", "risk_value": [99.0, 99.0]},  # skipped
        {"sensitivity_type": "Curvature", "risk_value": [99.0, 99.0]},  # skipped
    ]
    res = sbm.compute_kb_delta(rows, [0.5, 0.5], rho=0.5)
    assert res["count"] == 1
    assert res["S_b"] == pytest.approx(0.5 * 1.0 + 0.5 * 2.0, abs=1e-12)


def test_kb_delta_empty_returns_zero():
    res = sbm.compute_kb_delta([], [0.017, 0.017], rho=0.99)
    assert res == {"K_b": 0.0, "S_b": 0.0, "count": 0}


# ---- compute_kb_vega (GIRR Vega — single weight, per-element accumulate) -----

def test_kb_vega_two_rows_two_elements_each():
    # ws values = [0.3, 0.2, 0.1, -0.4]; SumWS = 0.2; SumWS^2 = 0.30
    # K_b^2 = 0.30 + 0.5 * (0.04 - 0.30) = 0.17
    rows = [
        {"sensitivity_type": "Vega", "risk_value": [0.3, 0.2]},
        {"sensitivity_type": "Vega", "risk_value": [0.1, -0.4]},
    ]
    res = sbm.compute_kb_vega(rows, weight=1.0, rho=0.5)
    assert res["count"] == 2
    assert res["S_b"] == pytest.approx(0.2, abs=1e-12)
    assert res["K_b"] == pytest.approx(math.sqrt(0.17), abs=1e-12)


def test_kb_vega_ignores_non_vega_rows():
    rows = [
        {"sensitivity_type": "Vega", "risk_value": [0.1, 0.2]},
        {"sensitivity_type": "Delta", "risk_value": [99.0]},  # skipped
    ]
    res = sbm.compute_kb_vega(rows, weight=1.0, rho=0.5)
    assert res["count"] == 1


# ---- compute_kb_scalar (Equity/FX — one weighted scalar per row) -------------

def test_kb_scalar_equity_bucket_two_rows():
    # Equity bucket 1: weight=0.55, rho=0.5
    # rows -> ws = [1.1, -0.55]; SumWS=0.55; SumWS^2=1.5125
    # K_b^2 = 1.5125 + 0.5 * (0.3025 - 1.5125) = 0.9075
    rows = [
        {"sensitivity_type": "Delta", "risk_value": 2.0},
        {"sensitivity_type": "Delta", "risk_value": -1.0},
    ]
    res = sbm.compute_kb_scalar(rows, weight=0.55, rho=0.5, sensitivity_type="Delta")
    assert res["count"] == 2
    assert res["S_b"] == pytest.approx(0.55, abs=1e-12)
    assert res["K_b"] == pytest.approx(math.sqrt(0.9075), abs=1e-12)


def test_kb_scalar_fx_bucket_three_rows():
    # FX bucket EURUSD: weight=0.075, rho=0.60
    # rows rv=[10,-5,2]; ws=[0.75,-0.375,0.15]; SumWS=0.525; SumWS^2=0.725625
    # K_b^2 = 0.725625 + 0.6 * (0.275625 - 0.725625) = 0.455625
    rows = [
        {"sensitivity_type": "Delta", "risk_value": 10.0},
        {"sensitivity_type": "Delta", "risk_value": -5.0},
        {"sensitivity_type": "Delta", "risk_value": 2.0},
    ]
    res = sbm.compute_kb_scalar(rows, weight=0.075, rho=0.60, sensitivity_type="Delta")
    assert res["S_b"] == pytest.approx(0.525, abs=1e-12)
    assert res["K_b"] == pytest.approx(math.sqrt(0.455625), abs=1e-12)


def test_kb_scalar_accepts_one_element_array_risk_value():
    # Generator emits ARRAY_NUMERIC even for scalar classes; we accept either.
    rows = [{"sensitivity_type": "Delta", "risk_value": [2.0]}]
    res = sbm.compute_kb_scalar(rows, weight=0.55, rho=0.5, sensitivity_type="Delta")
    assert res["S_b"] == pytest.approx(1.1, abs=1e-12)


# ---- reduce_charge (MAR21.4 cross-bucket combine) ----------------------------

def test_reduce_charge_positive_branch():
    # per = [(K=0.5,S=0.3),(K=0.4,S=-0.2)], gamma=0.5
    # sumK2 = 0.41; cross = 2*0.5*0.3*-0.2 = -0.06; charge = sqrt(0.35)
    per = [
        {"bucket": "USD", "K_b": 0.5, "S_b": 0.3, "count": 1},
        {"bucket": "EUR", "K_b": 0.4, "S_b": -0.2, "count": 1},
    ]
    assert sbm.reduce_charge(per, gamma=0.5) == pytest.approx(math.sqrt(0.35), abs=1e-12)


def test_reduce_charge_negative_branch_caps_S_in_K_bounds():
    # Force sum-inside-sqrt negative: large negative cross via S exceeding K.
    # Without capping: charge^2 < 0 -> must trigger alt formula.
    per = [
        {"bucket": "A", "K_b": 0.1, "S_b": 1.0, "count": 1},
        {"bucket": "B", "K_b": 0.1, "S_b": -1.0, "count": 1},
    ]
    # After capping: S_A=0.1, S_B=-0.1. sumK2=0.02; cross=2*0.99*0.1*-0.1=-0.0198.
    # charge = sqrt(max(0, 0.02-0.0198)) = sqrt(0.0002)
    assert sbm.reduce_charge(per, gamma=0.99) == pytest.approx(math.sqrt(0.0002), abs=1e-12)


def test_reduce_charge_empty_returns_zero():
    assert sbm.reduce_charge([], gamma=0.5) == 0.0
