"""CLI smoke tests — `python sbm.py --input X --risk-class girr --sensitivity-type delta`.

These run the script as a subprocess from a tiny generated input CSV and
parse the JSON it prints to stdout. The CLI exists so an operator (or a
verifier rerunning the demo) can re-derive a charge from a sample without
loading the whole Python API.
"""
import json
import subprocess
import sys
from pathlib import Path
import pytest

REPO_TOOLS = Path(__file__).resolve().parent.parent
SBM_PY = REPO_TOOLS / "sbm.py"
SCHEMA_YAML = REPO_TOOLS.parent.parent / "config" / "schema" / "frtb-default.yaml"


def _run_cli(args):
    return subprocess.run(
        [sys.executable, str(SBM_PY), *args],
        capture_output=True, text=True, check=False, cwd=str(REPO_TOOLS),
    )


def test_cli_girr_delta_prints_json_charge(tmp_path):
    csv_path = tmp_path / "girr-delta-input.csv"
    csv_path.write_text(
        "risk_class,bucket,sensitivity_type,risk_value\n"
        'GIRR,USD,Delta,"[1.0,2.0,0,0,0,0,0,0,0,0]"\n'
        'GIRR,USD,Delta,"[0.5,-1.0,0,0,0,0,0,0,0,0]"\n'
    )
    result = _run_cli([
        "--input", str(csv_path),
        "--risk-class", "girr",
        "--sensitivity-type", "delta",
        "--schema", str(SCHEMA_YAML),
    ])
    assert result.returncode == 0, f"stderr:\n{result.stderr}"
    out = json.loads(result.stdout)
    assert "charge" in out
    assert "per_bucket" in out
    assert out["risk_class"] == "GIRR"
    assert out["sensitivity_type"] == "Delta"
    assert out["per_bucket"][0]["bucket"] == "USD"


def test_cli_rejects_unknown_risk_class(tmp_path):
    csv_path = tmp_path / "bogus.csv"
    csv_path.write_text("risk_class,bucket,sensitivity_type,risk_value\nFOO,1,Delta,1.0\n")
    result = _run_cli([
        "--input", str(csv_path),
        "--risk-class", "foo",
        "--sensitivity-type", "delta",
        "--schema", str(SCHEMA_YAML),
    ])
    assert result.returncode != 0
