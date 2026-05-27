"""Deterministic generator for the small (~50 row) golden CSV fixtures.

These CSVs are consumed by:
  - the Python oracle's own round-trip test (tests/test_golden.py)
  - services/api/tests/mvp.e2e.test.ts (Equity + FX Redis-function compare)
  - Wave 4.1's RED tests (Equity + FX Lua impls in services/calc/lib/)

Re-run with `.venv/bin/python golden/generate.py` after changing the schema
or formula. Expected charges are also written to golden/expected.json.

The PRNG is a seeded numpy Generator so output is bit-for-bit reproducible
across machines and Python versions (same numpy version pinned in
requirements.txt).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

REPO_TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_TOOLS))
import sbm  # noqa: E402

ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = REPO_TOOLS.parent.parent / "config" / "schema" / "frtb-default.yaml"

SEED = 42
ROWS_PER_FILE = 50


def _rng() -> np.random.Generator:
    return np.random.default_rng(SEED)


def _girr_rows(rng: np.random.Generator, sens_type: str) -> pd.DataFrame:
    buckets = ["USD", "EUR", "GBP", "JPY"]
    tenor_count = 10
    rows = []
    for i in range(ROWS_PER_FILE):
        rv = rng.uniform(-1.0, 1.0, size=tenor_count).round(6).tolist()
        rows.append({
            "risk_class": "GIRR",
            "bucket": buckets[i % len(buckets)],
            "sensitivity_type": sens_type,
            "risk_value": rv,
        })
    return pd.DataFrame(rows)


def _equity_rows(rng: np.random.Generator, sens_type: str) -> pd.DataFrame:
    buckets = ["1", "2", "3", "4", "5", "6", "7"]
    rows = []
    for i in range(ROWS_PER_FILE):
        rv = float(round(rng.uniform(-5.0, 5.0), 6))
        rows.append({
            "risk_class": "EQUITY",
            "bucket": buckets[i % len(buckets)],
            "sensitivity_type": sens_type,
            "risk_value": rv,
        })
    return pd.DataFrame(rows)


def _fx_rows(rng: np.random.Generator, sens_type: str) -> pd.DataFrame:
    buckets = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD"]
    rows = []
    for i in range(ROWS_PER_FILE):
        rv = float(round(rng.uniform(-100.0, 100.0), 6))
        rows.append({
            "risk_class": "FX",
            "bucket": buckets[i % len(buckets)],
            "sensitivity_type": sens_type,
            "risk_value": rv,
        })
    return pd.DataFrame(rows)


def _serialise_csv(df: pd.DataFrame, path: Path) -> None:
    # JSON-encode list values so the round-trip parser (sbm._parse_risk_value)
    # rebuilds the same Python list. Scalars stay as plain floats.
    df = df.copy()
    df["risk_value"] = df["risk_value"].apply(
        lambda v: json.dumps(v) if isinstance(v, list) else v
    )
    df.to_csv(path, index=False)


def main() -> int:
    schema = yaml.safe_load(SCHEMA_PATH.read_text())
    expected: dict[str, dict] = {}
    plan = [
        ("girr-delta.csv", "GIRR", "Delta", _girr_rows),
        ("girr-vega.csv",  "GIRR", "Vega",  _girr_rows),
        ("equity-delta.csv", "EQUITY", "Delta", _equity_rows),
        ("equity-vega.csv",  "EQUITY", "Vega",  _equity_rows),
        ("fx-delta.csv", "FX", "Delta", _fx_rows),
        ("fx-vega.csv",  "FX", "Vega",  _fx_rows),
    ]
    for filename, rc, st, builder in plan:
        df = builder(_rng(), st)
        _serialise_csv(df, ROOT / filename)
        result = sbm.compute_sbm(df, rc, st, schema)
        expected[filename] = {
            "risk_class": result["risk_class"],
            "sensitivity_type": result["sensitivity_type"],
            "charge": result["charge"],
            "per_bucket": result["per_bucket"],
        }
        print(f"{filename:20s}  charge={result['charge']:.10f}  "
              f"buckets={len(result['per_bucket'])}  rows={len(df)}")
    (ROOT / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(f"wrote {ROOT / 'expected.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
