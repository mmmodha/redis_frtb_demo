#!/usr/bin/env python3
"""FRTB SBM reference oracle (MAR21 §21.4) — pandas + numpy.

Companion to the Redis Functions implementation in services/calc/lib/*.lua.
Used as the canonical out-of-process oracle for cross-validation:

    python sbm.py --input sample.csv --risk-class girr --sensitivity-type delta \
        --schema ../../config/schema/frtb-default.yaml

Per-bucket K_b uses the constant-rho specialisation locked for this PoV
(matches the schema's correlations.*.kind == "constant"):

    WS_k  = w_k · s_k                        (Delta: w_k by tenor; others scalar)
    K_b^2 = Σ WS_k^2  +  ρ · ((Σ WS_k)^2 − Σ WS_k^2)
    S_b   = Σ WS_k

Cross-bucket reduce (MAR21.4(5)–(7)):

    charge^2 = Σ K_b^2 + Σ_{b≠c} γ_{bc} · S_b · S_c
    If charge^2 < 0 → cap S_b ∈ [−K_b, +K_b] and recompute (alt formula).

Supported risk classes (in scope for the PoV): GIRR, EQUITY, FX.
Supported sensitivity types: Delta, Vega. Curvature is out of scope.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd


# ============================================================================
# Per-bucket K_b kernels
# ============================================================================

def compute_kb_delta(
    rows: Iterable[Mapping[str, Any]],
    weights: Sequence[float],
    rho: float,
) -> dict:
    """GIRR Delta — sum sensitivities per tenor across rows, then weight + K_b.

    Only rows with sensitivity_type == "Delta" contribute. risk_value is a
    list aligned with `weights` (per-tenor). Mirrors services/calc/lib/girr_delta.lua.
    """
    T = len(weights)
    sum_s = np.zeros(T, dtype=np.float64)
    count = 0
    for row in rows:
        if row.get("sensitivity_type") != "Delta":
            continue
        rv = row.get("risk_value")
        if not isinstance(rv, (list, tuple, np.ndarray)):
            continue
        n = min(T, len(rv))
        for k in range(n):
            v = rv[k]
            if isinstance(v, (int, float)) and math.isfinite(v):
                sum_s[k] += float(v)
        count += 1
    if count == 0:
        return {"K_b": 0.0, "S_b": 0.0, "count": 0}
    w = np.asarray(weights, dtype=np.float64)
    ws = w * sum_s
    sum_ws = float(ws.sum())
    sum_ws_sq = float((ws * ws).sum())
    return _kb_from_ws_sums(sum_ws, sum_ws_sq, rho, count)


def compute_kb_vega(
    rows: Iterable[Mapping[str, Any]],
    weight: float,
    rho: float,
) -> dict:
    """GIRR Vega — every element of risk_value is its own risk factor.

    Only rows with sensitivity_type == "Vega" contribute. Mirrors
    services/calc/lib/girr_vega.lua: single weight constant applied per element.
    """
    sum_ws = 0.0
    sum_ws_sq = 0.0
    count = 0
    for row in rows:
        if row.get("sensitivity_type") != "Vega":
            continue
        rv = row.get("risk_value")
        if isinstance(rv, (list, tuple, np.ndarray)):
            for v in rv:
                if isinstance(v, (int, float)) and math.isfinite(v):
                    ws = weight * float(v)
                    sum_ws += ws
                    sum_ws_sq += ws * ws
        elif isinstance(rv, (int, float)) and math.isfinite(rv):
            ws = weight * float(rv)
            sum_ws += ws
            sum_ws_sq += ws * ws
        count += 1
    if count == 0:
        return {"K_b": 0.0, "S_b": 0.0, "count": 0}
    return _kb_from_ws_sums(sum_ws, sum_ws_sq, rho, count)


def compute_kb_scalar(
    rows: Iterable[Mapping[str, Any]],
    weight: float,
    rho: float,
    sensitivity_type: str,
) -> dict:
    """Equity / FX — scalar sensitivity per row, single weight per bucket.

    Each row contributes exactly one weighted sensitivity (its row.risk_value,
    accepting either a scalar or a 1-element array from the generator).
    """
    sum_ws = 0.0
    sum_ws_sq = 0.0
    count = 0
    for row in rows:
        if row.get("sensitivity_type") != sensitivity_type:
            continue
        rv = row.get("risk_value")
        if isinstance(rv, (list, tuple, np.ndarray)):
            s = float(rv[0]) if len(rv) > 0 else None
        elif isinstance(rv, (int, float)) and math.isfinite(rv):
            s = float(rv)
        else:
            s = None
        if s is None or not math.isfinite(s):
            continue
        ws = weight * s
        sum_ws += ws
        sum_ws_sq += ws * ws
        count += 1
    if count == 0:
        return {"K_b": 0.0, "S_b": 0.0, "count": 0}
    return _kb_from_ws_sums(sum_ws, sum_ws_sq, rho, count)


def _kb_from_ws_sums(sum_ws: float, sum_ws_sq: float, rho: float, count: int) -> dict:
    cross = sum_ws * sum_ws - sum_ws_sq
    if cross < 0:
        cross = 0.0
    kb_sq = sum_ws_sq + rho * cross
    if kb_sq < 0:
        kb_sq = 0.0
    return {"K_b": math.sqrt(kb_sq), "S_b": sum_ws, "count": count}


# ============================================================================
# Cross-bucket reduce (MAR21.4(5)–(7))
# ============================================================================

def reduce_charge(per_bucket: Sequence[Mapping[str, float]], gamma: float) -> float:
    """charge = sqrt(Σ K_b^2 + Σ_{b≠c} γ S_b S_c), with the MAR21.4(7) alt."""
    if not per_bucket:
        return 0.0
    K = np.array([float(p["K_b"]) for p in per_bucket], dtype=np.float64)
    S = np.array([float(p["S_b"]) for p in per_bucket], dtype=np.float64)
    sum_k2 = float((K * K).sum())
    sum_s = float(S.sum())
    cross = gamma * (sum_s * sum_s - float((S * S).sum()))
    total = sum_k2 + cross
    if total >= 0:
        return math.sqrt(total)
    # Alt formula: cap S_b ∈ [-K_b, +K_b], recompute, floor at 0.
    Splus = np.clip(S, -K, K)
    sum_splus = float(Splus.sum())
    cross_alt = gamma * (sum_splus * sum_splus - float((Splus * Splus).sum()))
    return math.sqrt(max(sum_k2 + cross_alt, 0.0))


# ============================================================================
# Schema-driven dispatch
# ============================================================================

_KERNELS = {
    ("GIRR", "Delta"): "delta_by_tenor",
    ("GIRR", "Vega"): "vega_constant",
    ("EQUITY", "Delta"): "scalar_by_bucket",
    ("EQUITY", "Vega"): "scalar_by_bucket",
    ("FX", "Delta"): "scalar_constant",
    ("FX", "Vega"): "scalar_constant",
}


def _vega_convention(rc: str, suffix: str, table: Mapping[str, Any]) -> str | None:
    # Schema convention: vega-specific entries live under {risk_class}_vega_*.
    # Falls back to the delta entry when no vega override is defined.
    candidate = f"{rc.lower()}_vega_{suffix}"
    return candidate if candidate in table else None


def _resolve_weights_ref(rc: str, st: str, cls_cfg: Mapping[str, Any], schema: Mapping[str, Any]) -> str:
    if st == "Vega":
        explicit = cls_cfg.get("vega_risk_weights_ref")
        if explicit:
            return explicit
        conv = _vega_convention(rc, "weights", schema.get("risk_weights", {}))
        if conv:
            return conv
    return cls_cfg["risk_weights_ref"]


def _resolve_intra_ref(rc: str, st: str, cls_cfg: Mapping[str, Any], schema: Mapping[str, Any]) -> str:
    if st == "Vega":
        explicit = cls_cfg.get("vega_intra_bucket_correlation_ref")
        if explicit:
            return explicit
        conv = _vega_convention(rc, "rho_kl", schema.get("correlations", {}))
        if conv:
            return conv
        conv2 = _vega_convention(rc, "rho", schema.get("correlations", {}))
        if conv2:
            return conv2
    return cls_cfg["intra_bucket_correlation_ref"]


def _resolve_cross_ref(rc: str, st: str, cls_cfg: Mapping[str, Any], schema: Mapping[str, Any]) -> str:
    if st == "Vega":
        explicit = cls_cfg.get("vega_cross_bucket_correlation_ref")
        if explicit:
            return explicit
        conv = _vega_convention(rc, "gamma_bc", schema.get("correlations", {}))
        if conv:
            return conv
        conv2 = _vega_convention(rc, "gamma", schema.get("correlations", {}))
        if conv2:
            return conv2
    return cls_cfg["cross_bucket_correlation_ref"]


def _constant(corr_block: Mapping[str, Any]) -> float:
    if corr_block.get("kind") != "constant":
        raise ValueError(f"only constant-rho/gamma supported in this oracle: {corr_block}")
    return float(corr_block["value"])


def compute_sbm(
    df: pd.DataFrame,
    risk_class: str,
    sensitivity_type: str,
    schema: Mapping[str, Any],
) -> dict:
    """Schema-driven dispatch returning {'charge', 'per_bucket', 'risk_class', ...}."""
    risk_class = risk_class.upper()
    sensitivity_type = sensitivity_type.capitalize()
    key = (risk_class, sensitivity_type)
    if key not in _KERNELS:
        raise ValueError(f"unsupported (risk_class, sensitivity_type): {key}")
    classes = schema.get("risk_classes") or {}
    if risk_class not in classes:
        raise KeyError(f"risk_class {risk_class} not defined in schema")
    cls_cfg = classes[risk_class]

    weights_ref = _resolve_weights_ref(risk_class, sensitivity_type, cls_cfg, schema)
    weights_block = schema["risk_weights"][weights_ref]
    rho = _constant(schema["correlations"][_resolve_intra_ref(risk_class, sensitivity_type, cls_cfg, schema)])
    gamma = _constant(schema["correlations"][_resolve_cross_ref(risk_class, sensitivity_type, cls_cfg, schema)])

    kernel = _KERNELS[key]
    rows_by_bucket: dict[str, list[dict]] = {}
    for rec in df.to_dict(orient="records"):
        rows_by_bucket.setdefault(str(rec["bucket"]), []).append(rec)

    per_bucket: list[dict] = []
    for bucket, rows in rows_by_bucket.items():
        if kernel == "delta_by_tenor":
            tenor_nodes = cls_cfg["tenor"]["nodes"]
            weights = [float(weights_block["by_tenor"][t]) for t in tenor_nodes]
            res = compute_kb_delta(rows, weights, rho)
        elif kernel == "vega_constant":
            res = compute_kb_vega(rows, float(weights_block["constant"]), rho)
        elif kernel == "scalar_by_bucket":
            w = float(weights_block["by_bucket"][bucket])
            res = compute_kb_scalar(rows, w, rho, sensitivity_type)
        else:  # scalar_constant
            res = compute_kb_scalar(rows, float(weights_block["constant"]), rho, sensitivity_type)
        per_bucket.append({"bucket": bucket, **res})

    per_bucket.sort(key=lambda r: r["bucket"])
    charge = reduce_charge(per_bucket, gamma)
    return {
        "risk_class": risk_class,
        "sensitivity_type": sensitivity_type,
        "per_bucket": per_bucket,
        "charge": charge,
    }


# ============================================================================
# CLI
# ============================================================================

def _read_input(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".json":
        obj = json.loads(path.read_text())
        return pd.DataFrame(obj.get("rows", obj) if isinstance(obj, dict) else obj)
    df = pd.read_csv(path)
    if "risk_value" in df.columns:
        df["risk_value"] = df["risk_value"].apply(_parse_risk_value)
    return df


def _parse_risk_value(v):
    if isinstance(v, (list, tuple, np.ndarray)):
        return list(v)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    if s.startswith("["):
        return json.loads(s)
    try:
        return float(s)
    except ValueError:
        return None


def _load_schema(path: Path) -> dict:
    import yaml  # lazy — keeps pure-API import cheap
    return yaml.safe_load(path.read_text())


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FRTB SBM reference oracle (MAR21).")
    parser.add_argument("--input", required=True, type=Path, help="CSV or JSON with rows")
    parser.add_argument("--risk-class", required=True, choices=["girr", "equity", "fx", "GIRR", "EQUITY", "FX"])
    parser.add_argument("--sensitivity-type", required=True, choices=["delta", "vega", "Delta", "Vega"])
    parser.add_argument("--schema", required=True, type=Path, help="Path to frtb-default.yaml")
    args = parser.parse_args(argv)
    df = _read_input(args.input)
    schema = _load_schema(args.schema)
    out = compute_sbm(df, args.risk_class, args.sensitivity_type, schema)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
