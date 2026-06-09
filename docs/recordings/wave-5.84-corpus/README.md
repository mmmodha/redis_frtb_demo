# Wave 5.84-corpus — canonical 200k anchor capture

Captured **2026-06-08** against the live `/calc/sbm` api after loading the
balanced-thirds 200k corpus:

```bash
docker compose run --rm generator --rows 200000 --classes GIRR,EQUITY,FX
```

Class distribution: **GIRR 66667 / EQUITY 66667 / FX 66666** (balanced thirds).

## Artefacts

- `parity-sweep.json` — 6-variant sweep `(GIRR,EQUITY,FX) × (Delta,Vega)` with
  both `force_path=lua` and `force_path=fast`. Lua is authoritative; the file
  also records `rel_delta`, engine name, total_ms, bucket count, and row count
  per variant. Lua≡fast to ≤1.8e-13 relative on all six variants.
- `buckets.json` — per-bucket `K_b` + `S_b` for the three multi-bucket Delta
  variants (GIRR/Delta, EQUITY/Delta, FX/Delta), captured via `force_path=lua`.

These artefacts feed `CHARGE_ANCHORS` and `BUCKET_ANCHORS` in
[`services/api/tests/calc-live-200k.test.ts`](../../../services/api/tests/calc-live-200k.test.ts)
and supersede the legacy skewed-mix anchors under
[`docs/recordings/wave-5.83K/`](../wave-5.83K/).
