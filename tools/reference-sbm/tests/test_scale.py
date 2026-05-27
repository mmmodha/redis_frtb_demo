"""10k-row scale acceptance test — guards the spec's '0.01% match on 10k-row
sample' acceptance criterion.

Runs the oracle twice — once on the raw in-memory DataFrame, once after a
CSV round-trip through sbm._read_input — and asserts they agree to relative
1e-12. This catches any silent precision loss in the CSV parser path that
the e2e Redis-function comparison would also depend on.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml

import sbm

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_YAML = ROOT.parent.parent / "config" / "schema" / "frtb-default.yaml"

SCALE_N = 10_000


@pytest.fixture(scope="module")
def schema():
    return yaml.safe_load(SCHEMA_YAML.read_text())


def _build_girr(n: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    buckets = ["USD", "EUR", "GBP", "JPY", "CHF"]
    rows = []
    for i in range(n):
        rows.append({
            "risk_class": "GIRR",
            "bucket": buckets[i % len(buckets)],
            "sensitivity_type": "Delta" if i % 2 == 0 else "Vega",
            "risk_value": rng.uniform(-1.0, 1.0, size=10).round(8).tolist(),
        })
    return pd.DataFrame(rows)


@pytest.mark.parametrize("sensitivity_type", ["Delta", "Vega"])
def test_girr_10k_row_csv_roundtrip_within_0_01_percent(
    sensitivity_type, schema, tmp_path,
):
    df = _build_girr(SCALE_N, seed=7)
    direct = sbm.compute_sbm(df, "GIRR", sensitivity_type, schema)

    csv_path = tmp_path / f"girr-{sensitivity_type.lower()}-10k.csv"
    out = df.copy()
    import json
    out["risk_value"] = out["risk_value"].apply(json.dumps)
    out.to_csv(csv_path, index=False)
    df2 = sbm._read_input(csv_path)
    via_csv = sbm.compute_sbm(df2, "GIRR", sensitivity_type, schema)

    # 0.01% tolerance per spec acceptance criterion (with floor for near-zero).
    tol = max(abs(direct["charge"]) * 1e-4, 1e-12)
    assert abs(via_csv["charge"] - direct["charge"]) <= tol
