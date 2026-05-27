"""End-to-end `compute_sbm(df, risk_class, sensitivity_type, schema)` tests.

This is the public entry point used by the CLI and (indirectly) by the
e2e oracle round-trip. Tests verify it dispatches to the right per-bucket
kernel (delta/vega/scalar) and reduces with the right gamma per the schema.
"""
import math
import pandas as pd
import pytest

import sbm


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
    # sum_s = [1.5, 1.0, 0, ...]; WS = [0.0255, 0.017, ...]; SumWS = 0.0425
    # SumWS^2 = 0.00065025 + 0.000289 = 0.00093925
    # K_b^2 = 0.00093925 + 0.99 * (0.0425^2 - 0.00093925) = 0.00093925 + 0.99*0.00087700 = 0.00094*+...
    # K_b^2 = 0.00093925 + 0.99 * 0.000867 = 0.00093925 + 0.00085833 = 0.00179758
    res = sbm.compute_sbm(df, "GIRR", "Delta", SCHEMA)
    assert len(res["per_bucket"]) == 1
    bucket = res["per_bucket"][0]
    assert bucket["bucket"] == "USD"
    assert bucket["S_b"] == pytest.approx(0.0425, abs=1e-12)
    assert bucket["K_b"] == pytest.approx(math.sqrt(0.00179758), abs=1e-9)
    # Single bucket: charge = K_b
    assert res["charge"] == pytest.approx(bucket["K_b"], abs=1e-12)


def test_compute_sbm_equity_two_buckets_reduce():
    # Bucket 1: weight 0.55, 1 row rv=1.0 → ws=0.55; K=|0.55|=0.55 (single factor)
    # Bucket 2: weight 0.60, 1 row rv=-1.0 → ws=-0.6; K=0.6
    # gamma=0.15: charge^2 = 0.55^2 + 0.6^2 + 2*0.15*0.55*-0.6
    #           = 0.3025 + 0.36 - 0.099 = 0.5635
    df = pd.DataFrame([
        {"risk_class": "EQUITY", "bucket": "1", "sensitivity_type": "Delta", "risk_value": 1.0},
        {"risk_class": "EQUITY", "bucket": "2", "sensitivity_type": "Delta", "risk_value": -1.0},
    ])
    res = sbm.compute_sbm(df, "EQUITY", "Delta", SCHEMA)
    buckets = {b["bucket"]: b for b in res["per_bucket"]}
    assert buckets["1"]["S_b"] == pytest.approx(0.55, abs=1e-12)
    assert buckets["2"]["S_b"] == pytest.approx(-0.6, abs=1e-12)
    assert res["charge"] == pytest.approx(math.sqrt(0.5635), abs=1e-12)


def test_compute_sbm_fx_single_bucket_delta():
    df = pd.DataFrame([
        {"risk_class": "FX", "bucket": "EURUSD", "sensitivity_type": "Delta", "risk_value": 10.0},
        {"risk_class": "FX", "bucket": "EURUSD", "sensitivity_type": "Delta", "risk_value": -5.0},
        {"risk_class": "FX", "bucket": "EURUSD", "sensitivity_type": "Delta", "risk_value": 2.0},
    ])
    res = sbm.compute_sbm(df, "FX", "Delta", SCHEMA)
    assert res["per_bucket"][0]["S_b"] == pytest.approx(0.525, abs=1e-12)
    assert res["per_bucket"][0]["K_b"] == pytest.approx(math.sqrt(0.455625), abs=1e-12)


def test_compute_sbm_girr_vega_filters_to_vega_rows():
    df = pd.DataFrame([
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Delta", "risk_value": [99.0, 99.0]},
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Vega", "risk_value": [0.3, 0.2]},
        {"risk_class": "GIRR", "bucket": "USD", "sensitivity_type": "Vega", "risk_value": [0.1, -0.4]},
    ])
    res = sbm.compute_sbm(df, "GIRR", "Vega", SCHEMA)
    assert res["per_bucket"][0]["count"] == 2
    assert res["per_bucket"][0]["K_b"] == pytest.approx(math.sqrt(0.17), abs=1e-12)


def test_compute_sbm_unknown_risk_class_raises():
    df = pd.DataFrame([{"risk_class": "BOGUS", "bucket": "X",
                        "sensitivity_type": "Delta", "risk_value": [1.0]}])
    with pytest.raises((KeyError, ValueError)):
        sbm.compute_sbm(df, "BOGUS", "Delta", SCHEMA)
