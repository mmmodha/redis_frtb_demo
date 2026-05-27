"""Hand-computed worked examples — the failing-first oracle contract.

Mirrors the locked PoV semantics in services/calc/lib/girr_delta.lua and
girr_vega.lua:

    cross   = max(0, (ΣWS)^2 − ΣWS^2)        # clipped at 0
    K_b^2   = max(0, ΣWS^2 + ρ · cross)
    K_b     = sqrt(K_b^2)
    S_b     = Σ WS

Expected values are computed algebraically inside each test (no hardcoded
decimals) so any future change to the clipping rule is visible directly.
"""
import math
import pytest

import sbm  # noqa: F401 — fails in RED until sbm.py exists


def _expected_kb_sb(ws_values, rho):
    """Reference closed form for the constant-rho specialisation (with clip)."""
    sum_ws = sum(ws_values)
    sum_ws_sq = sum(v * v for v in ws_values)
    cross = max(0.0, sum_ws * sum_ws - sum_ws_sq)
    kb_sq = max(0.0, sum_ws_sq + rho * cross)
    return math.sqrt(kb_sq), sum_ws


# ---- compute_kb_delta (GIRR Delta — weights per tenor, constant-rho) ---------

def test_kb_delta_two_rows_three_tenors_positive_cross():
    # sum_s per tenor = [1.5, 1.0, 5.0]; WS = [0.0255, 0.017, 0.08].
    # Same-sign WS -> cross stays positive -> kb math is the full MAR21 form.
    rows = [
        {"sensitivity_type": "Delta", "risk_value": [1.0, 2.0, 3.0]},
        {"sensitivity_type": "Delta", "risk_value": [0.5, -1.0, 2.0]},
    ]
    weights = [0.017, 0.017, 0.016]
    expected_K, expected_S = _expected_kb_sb([0.017*1.5, 0.017*1.0, 0.016*5.0], 0.99)
    res = sbm.compute_kb_delta(rows, weights, rho=0.99)
    assert res["count"] == 2
    assert res["S_b"] == pytest.approx(expected_S, abs=1e-12)
    assert res["K_b"] == pytest.approx(expected_K, abs=1e-12)


def test_kb_delta_ignores_non_delta_rows():
    rows = [
        {"sensitivity_type": "Delta", "risk_value": [1.0, 2.0]},
        {"sensitivity_type": "Vega", "risk_value": [99.0, 99.0]},
        {"sensitivity_type": "Curvature", "risk_value": [99.0, 99.0]},
    ]
    res = sbm.compute_kb_delta(rows, [0.5, 0.5], rho=0.5)
    assert res["count"] == 1
    assert res["S_b"] == pytest.approx(0.5 * 1.0 + 0.5 * 2.0, abs=1e-12)


def test_kb_delta_empty_returns_zero():
    res = sbm.compute_kb_delta([], [0.017, 0.017], rho=0.99)
    assert res == {"K_b": 0.0, "S_b": 0.0, "count": 0}


# ---- compute_kb_vega (GIRR Vega — single weight, per-element accumulate) -----

def test_kb_vega_two_rows_two_elements_each_clips_negative_cross():
    # ws values = [0.3, 0.2, 0.1, -0.4]: mixed signs -> (ΣWS)^2 - ΣWS^2 < 0
    # locked semantics: cross clipped to 0 -> K_b = sqrt(ΣWS^2)
    rows = [
        {"sensitivity_type": "Vega", "risk_value": [0.3, 0.2]},
        {"sensitivity_type": "Vega", "risk_value": [0.1, -0.4]},
    ]
    expected_K, expected_S = _expected_kb_sb([0.3, 0.2, 0.1, -0.4], 0.5)
    res = sbm.compute_kb_vega(rows, weight=1.0, rho=0.5)
    assert res["count"] == 2
    assert res["S_b"] == pytest.approx(expected_S, abs=1e-12)
    assert res["K_b"] == pytest.approx(expected_K, abs=1e-12)


def test_kb_vega_ignores_non_vega_rows():
    rows = [
        {"sensitivity_type": "Vega", "risk_value": [0.1, 0.2]},
        {"sensitivity_type": "Delta", "risk_value": [99.0]},
    ]
    res = sbm.compute_kb_vega(rows, weight=1.0, rho=0.5)
    assert res["count"] == 1


# ---- compute_kb_scalar (Equity/FX — one weighted scalar per row) -------------

def test_kb_scalar_equity_bucket_two_rows_clips_negative_cross():
    # ws = [1.1, -0.55]; opposite signs -> cross clipped to 0 -> K_b = sqrt(ΣWS^2)
    rows = [
        {"sensitivity_type": "Delta", "risk_value": 2.0},
        {"sensitivity_type": "Delta", "risk_value": -1.0},
    ]
    expected_K, expected_S = _expected_kb_sb([0.55 * 2.0, 0.55 * -1.0], 0.5)
    res = sbm.compute_kb_scalar(rows, weight=0.55, rho=0.5, sensitivity_type="Delta")
    assert res["count"] == 2
    assert res["S_b"] == pytest.approx(expected_S, abs=1e-12)
    assert res["K_b"] == pytest.approx(expected_K, abs=1e-12)


def test_kb_scalar_fx_bucket_three_rows_clips_negative_cross():
    rows = [
        {"sensitivity_type": "Delta", "risk_value": 10.0},
        {"sensitivity_type": "Delta", "risk_value": -5.0},
        {"sensitivity_type": "Delta", "risk_value": 2.0},
    ]
    expected_K, expected_S = _expected_kb_sb(
        [0.075 * 10.0, 0.075 * -5.0, 0.075 * 2.0], 0.60,
    )
    res = sbm.compute_kb_scalar(rows, weight=0.075, rho=0.60, sensitivity_type="Delta")
    assert res["S_b"] == pytest.approx(expected_S, abs=1e-12)
    assert res["K_b"] == pytest.approx(expected_K, abs=1e-12)


def test_kb_scalar_accepts_one_element_array_risk_value():
    # Generator emits ARRAY_NUMERIC even for scalar classes; we accept either.
    rows = [{"sensitivity_type": "Delta", "risk_value": [2.0]}]
    res = sbm.compute_kb_scalar(rows, weight=0.55, rho=0.5, sensitivity_type="Delta")
    assert res["S_b"] == pytest.approx(1.1, abs=1e-12)


# ---- reduce_charge (MAR21.4 cross-bucket combine) ----------------------------

def test_reduce_charge_positive_branch():
    # per = [(K=0.5,S=0.3),(K=0.4,S=-0.2)], gamma=0.5
    # sumK2 = 0.41; cross = γ*((ΣS)^2 - ΣS^2) = 0.5*(0.01 - 0.13) = -0.06
    # charge = sqrt(0.35)
    per = [
        {"bucket": "USD", "K_b": 0.5, "S_b": 0.3, "count": 1},
        {"bucket": "EUR", "K_b": 0.4, "S_b": -0.2, "count": 1},
    ]
    assert sbm.reduce_charge(per, gamma=0.5) == pytest.approx(math.sqrt(0.35), abs=1e-12)


def test_reduce_charge_negative_branch_caps_S_in_K_bounds():
    # Forces the alt formula: ΣS_capped = 0; cross_alt = 0.99*(0 - 0.02) = -0.0198
    # charge = sqrt(max(0, 0.02 - 0.0198)) = sqrt(0.0002)
    per = [
        {"bucket": "A", "K_b": 0.1, "S_b": 1.0, "count": 1},
        {"bucket": "B", "K_b": 0.1, "S_b": -1.0, "count": 1},
    ]
    assert sbm.reduce_charge(per, gamma=0.99) == pytest.approx(math.sqrt(0.0002), abs=1e-12)


def test_reduce_charge_empty_returns_zero():
    assert sbm.reduce_charge([], gamma=0.5) == 0.0
