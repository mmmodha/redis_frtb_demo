# Commit history notes

Small annotations for future archaeology. Git history is **not** rewritten.

## Mixed-wave attribution: commit `1af47a5`

Commit `1af47a5` is subject-labeled `feat(wave-4.3): GREEN — presenter docs, asset pack builder, competitive`, but in practice it delivered work from **two** waves in a single commit:

- **Wave 4.3** — `tools/reference-sbm/sbm.py` and the golden CSVs (`tools/reference-sbm/golden/*`, plus the accompanying `test_golden.py` / `test_scale.py`).
- **Wave 4.5** — the presenter pack (`docs/presenter/*`, `docs/deck/competitive-positioning.html`, `tools/asset-pack/*`, and the `tests/monorepo/docs-*.test.js` suite).

The content of both waves is correct and verified; only the commit subject is mixed. Treat the commit as covering both Wave 4.3 and Wave 4.5 when bisecting or auditing.
