"""End-to-end `compute_sbm(df, risk_class, sensitivity_type, schema)` tests.

This is the public entry point used by the CLI and (indirectly) by the
e2e oracle round-trip. Tests verify it dispatches to the right per-bucket
kernel (delta/vega/scalar) and reduces with the right gamma per the schema.
"""
import math
import pandas as pd
import pytest

import sbm


def _expected_kb_sb(ws_values, rho):
    """Reference closed form with the locked clip-cross-to-0 semantics."""
    sum_ws = sum(ws_values)
    sum_ws_sq = sum(v * v for v in ws_values)
    cross = max(0.0, sum_ws * sum_ws - sum_ws_sq)
    kb_sq = max(0.0, sum_ws_sq + rho * cross)
    return math.sqrt(kb_sq), sum_ws


SCHEMA = {
    "risk_weights": {
        "girr_delta_weights": {"by_tenor": {
            "3M": 0.017, "6M": 0.017, "1Y": 0.016, "2Y": 0.013, "3Y": 0.012,
            "5Y": 0.011, "10Y": 0.011, "15Y": 0.011, "20Y": 0.011, "30Y": 0.011,
        }},
        "girr_vega_weights": {"constant": 1.0},
        "equity_weights": {"by_bucket": {"1": 0.55, "2": 0.60}},
        "fx_weights": {"constant": 0.075},
    },
    "correlations": {
        "girr_rho_kl": {"kind": "constant", "value": 0.99},
        "girr_gamma_bc": {"kind": "constant", "value": 0.50},
        "girr_vega_rho_kl": {"kind": "constant", "value": 0.50},
        "girr_vega_gamma_bc": {"kind": "constant", "value": 0.50},
        "equity_rho": {"kind": "constant", "value": 0.50},
        "equity_gamma": {"kind": "constant", "value": 0.15},
        "fx_rho": {"kind": "constant", "value": 0.60},
        "fx_gamma": {"kind": "constant", "value": 0.60},
    },
    "risk_classes": {
        "GIRR": {
            "tenor": {"nodes": ["3M","6M","1Y","2Y","3Y","5Y","10Y","15Y","20Y","30Y"]},
            "risk_weights_ref": "girr_delta_weights",
            "intra_bucket_correlation_ref": "girr_rho_kl",
            "cross_bucket_correlation_ref": "girr_gamma_bc",
            "vega_risk_weights_ref": "girr_vega_weights",
            "vega_intra_bucket_correlation_ref": "girr_vega_rho_kl",
            "vega_cross_bucket_correlation_ref": "girr_vega_gamma_bc",
        },
        "EQUITY": {
            "risk_weights_ref": "equity_weights",
            "intra_bucket_correlation_ref": "equity_rho",
            "cross_bucket_correlation_ref": "equity_gamma",
        },
        "FX": {
            "risk_weights_ref": "fx_weights",
            "intra_bucket_correlation_ref": "fx_rho",
            "cross_bucket_correlation_ref": "fx_gamma",
        },
    },
}


def test_compute_sbm_girr_delta_single_bucket_matches_hand_calc():
    df = pd.DataFrame([
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Delta",
         "risk_value": [1.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]},
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Delta",
         "risk_value": [0.5, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]},
    ])
    # WS = [0.017*1.5, 0.017*1.0, zeros...]; same-sign -> positive cross.
    expected_K, expected_S = _expected_kb_sb([0.017 * 1.5, 0.017 * 1.0], 0.99)
    res = sbm.compute_sbm(df, "GIRR", "Delta", SCHEMA)
    bucket = res["per_bucket"][0]
    assert bucket["bucket"] == "USD"
    assert bucket["S_b"] == pytest.approx(expected_S, abs=1e-12)
    assert bucket["K_b"] == pytest.approx(expected_K, abs=1e-12)
    assert res["charge"] == pytest.approx(bucket["K_b"], abs=1e-12)


def test_compute_sbm_equity_two_buckets_reduce():
    # B1: ws=[0.55]; B2: ws=[-0.6]; both single-element -> K_b = |ws|.
    # Cross-bucket: gamma=0.15; ΣS=−0.05; cross=γ*(ΣS^2-(0.55^2+0.6^2))
    #             = 0.15*(0.0025 - 0.6625) = -0.099
    # charge^2 = 0.3025 + 0.36 - 0.099 = 0.5635
    df = pd.DataFrame([
        {"risk_class": "EQUITY", "bucket": "1", "sensitivity_type": "Delta", "risk_value": 1.0},
        {"risk_class": "EQUITY", "bucket": "2", "sensitivity_type": "Delta", "risk_value": -1.0},
    ])
    res = sbm.compute_sbm(df, "EQUITY", "Delta", SCHEMA)
    buckets = {b["bucket"]: b for b in res["per_bucket"]}
    assert buckets["1"]["S_b"] == pytest.approx(0.55, abs=1e-12)
    assert buckets["2"]["S_b"] == pytest.approx(-0.6, abs=1e-12)
    assert res["charge"] == pytest.approx(math.sqrt(0.5635), abs=1e-12)


def test_compute_sbm_fx_single_bucket_delta_clips_negative_cross():
    df = pd.DataFrame([
        {"risk_class": "FX", "bucket": "EURUSD", "sensitivity_type": "Delta", "risk_value": 10.0},
        {"risk_class": "FX", "bucket": "EURUSD", "sensitivity_type": "Delta", "risk_value": -5.0},
        {"risk_class": "FX", "bucket": "EURUSD", "sensitivity_type": "Delta", "risk_value": 2.0},
    ])
    expected_K, expected_S = _expected_kb_sb([0.075 * 10.0, 0.075 * -5.0, 0.075 * 2.0], 0.60)
    res = sbm.compute_sbm(df, "FX", "Delta", SCHEMA)
    assert res["per_bucket"][0]["S_b"] == pytest.approx(expected_S, abs=1e-12)
    assert res["per_bucket"][0]["K_b"] == pytest.approx(expected_K, abs=1e-12)


def test_compute_sbm_girr_vega_filters_to_vega_rows():
    df = pd.DataFrame([
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Delta", "risk_value": [99.0, 99.0]},
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Vega", "risk_value": [0.3, 0.2]},
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Vega", "risk_value": [0.1, -0.4]},
    ])
    expected_K, _ = _expected_kb_sb([0.3, 0.2, 0.1, -0.4], 0.5)
    res = sbm.compute_sbm(df, "GIRR", "Vega", SCHEMA)
    assert res["per_bucket"][0]["count"] == 2
    assert res["per_bucket"][0]["K_b"] == pytest.approx(expected_K, abs=1e-12)


def test_compute_sbm_unknown_risk_class_raises():
    df = pd.DataFrame([{"risk_class": "BOGUS", "bucket": "X",
                        "sensitivity_type": "Delta", "risk_value": [1.0]}])
    with pytest.raises((KeyError, ValueError)):
        sbm.compute_sbm(df, "BOGUS", "Delta", SCHEMA)
