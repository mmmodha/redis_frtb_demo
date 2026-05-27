"""Round-trip the golden CSVs through compute_sbm and assert charge matches.

Goldens live in tools/reference-sbm/golden/{class}-{type}.csv with their
expected per-bucket K_b/S_b/charge in golden/expected.json. This test guards
against drift in the oracle itself: if you change sbm.py and forget to
regenerate the goldens (via golden/generate.py), this test fails loudly.

It also exercises the CSV->DataFrame parsing path (sbm._parse_risk_value)
used by the CLI, which the unit tests do not cover end-to-end.
"""
import json
from pathlib import Path

import pytest
import yaml

import sbm

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "golden"
SCHEMA_YAML = ROOT.parent.parent / "config" / "schema" / "frtb-default.yaml"


@pytest.fixture(scope="module")
def schema():
    return yaml.safe_load(SCHEMA_YAML.read_text())


@pytest.fixture(scope="module")
def expected():
    return json.loads((GOLDEN / "expected.json").read_text())


@pytest.mark.parametrize("filename,risk_class,sensitivity_type", [
    ("girr-delta.csv",   "GIRR",   "Delta"),
    ("girr-vega.csv",    "GIRR",   "Vega"),
    ("equity-delta.csv", "EQUITY", "Delta"),
    ("equity-vega.csv",  "EQUITY", "Vega"),
    ("fx-delta.csv",     "FX",     "Delta"),
    ("fx-vega.csv",      "FX",     "Vega"),
])
def test_golden_csv_roundtrip_matches_expected_charge(
    filename, risk_class, sensitivity_type, schema, expected,
):
    csv_path = GOLDEN / filename
    assert csv_path.exists(), f"missing golden {csv_path}"
    df = sbm._read_input(csv_path)
    result = sbm.compute_sbm(df, risk_class, sensitivity_type, schema)
    exp = expected[filename]
    assert result["risk_class"] == exp["risk_class"]
    assert result["sensitivity_type"] == exp["sensitivity_type"]
    assert result["charge"] == pytest.approx(exp["charge"], rel=1e-12, abs=1e-12)
    by_bucket = {b["bucket"]: b for b in result["per_bucket"]}
    for exp_bucket in exp["per_bucket"]:
        actual = by_bucket[exp_bucket["bucket"]]
        assert actual["K_b"] == pytest.approx(exp_bucket["K_b"], rel=1e-12, abs=1e-12)
        assert actual["S_b"] == pytest.approx(exp_bucket["S_b"], rel=1e-12, abs=1e-12)
        assert actual["count"] == exp_bucket["count"]


def test_golden_files_are_small():
    # Spec asks for ~50-row goldens — guard against accidental balloon.
    for csv_path in GOLDEN.glob("*.csv"):
        line_count = sum(1 for _ in csv_path.open())
        assert line_count <= 60, f"{csv_path.name} has {line_count} lines"
