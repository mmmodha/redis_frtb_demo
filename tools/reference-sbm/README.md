# FRTB SBM Reference Oracle (Python)

Pure-Python reference implementation of the FRTB SBM charge per MAR21 §21.4 —
GIRR, Equity, FX × Delta + Vega. Used as the canonical out-of-process oracle
to cross-validate the Redis Functions implementation in
`services/calc/lib/*.lua`.

## Quick start

```bash
cd tools/reference-sbm
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Re-derive a charge from a sample
.venv/bin/python sbm.py \
    --input golden/girr-delta.csv \
    --risk-class girr \
    --sensitivity-type delta \
    --schema ../../config/schema/frtb-default.yaml

# Run the test suite
.venv/bin/pytest tests/ -v

# Regenerate the golden CSVs (after schema or formula change)
.venv/bin/python golden/generate.py
```

## Layout

| Path | Purpose |
|------|---------|
| `sbm.py` | Oracle module + CLI |
| `requirements.txt` | Pinned deps (numpy, pandas, PyYAML, pytest) |
| `tests/test_sbm.py` | Hand-computed kernel unit tests |
| `tests/test_compute_sbm.py` | Schema-driven dispatch tests |
| `tests/test_cli.py` | CLI subprocess smoke tests |
| `tests/test_golden.py` | Round-trip the goldens through `compute_sbm` |
| `tests/test_scale.py` | 10k-row CSV round-trip <0.01% acceptance |
| `golden/*.csv` | Small (~50 row) fixtures per `(risk_class, sensitivity_type)` |
| `golden/expected.json` | Expected per-bucket K_b / S_b / charge for each CSV |
| `golden/generate.py` | Deterministic seeded generator (SEED=42) |

## Locked semantics (matches Lua + TS oracles)

Per `services/calc/lib/girr_delta.lua` and `girrDeltaReference.ts`, the cross
term is clipped at 0 before mixing into K_b²:

```
WS_k    = w_k * s_k                  # Delta: w_k by tenor; others scalar
cross   = max(0, (ΣWS)² - ΣWS²)
K_b²    = max(0, ΣWS² + ρ · cross)
K_b     = sqrt(K_b²)
S_b     = Σ WS_k
charge² = Σ K_b² + Σ_{b≠c} γ_bc · S_b · S_c
```

When `charge² < 0`, the MAR21.4(7) alternative caps `S_b ∈ [-K_b, +K_b]`
before recomputing.

## Used by

- `services/api/tests/mvp.e2e.test.ts` — reads each golden CSV, ingests into
  Redis, calls `POST /calc/sbm`, asserts ≤ 1e-4 of `expected.json`'s charge.
- Wave 4.1's RED tests for Equity + FX Lua impls consume the golden CSVs as
  their fixed-input fixtures.
