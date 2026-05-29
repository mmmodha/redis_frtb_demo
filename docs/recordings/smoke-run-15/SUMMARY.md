# Wave 5.15o-v2 — Smoke validation on new standalone DB

**Run date:** 2026-05-29
**Target DB:** `lip-veil-spring-32424.db.redis.io:14596` (standalone, 1 master + 1 replica, 2.5 GB cap, `noeviction`, TLS off)
**Cost caps:** ≤ 10 MB peak `used_memory`, ≤ 2,500 rows, 1 ingest cycle, no loadgen.

## Verdict
🔴 **RED — pre-flight failure. Aborted before any compose / probe / ingest activity.**

Reason: pre-flight gate #1 missed. `.env.local` is present but does **not** contain `REDIS_CLUSTER=false`. Per the task's hard rule ("If absent, STOP and report — do not edit `.env.local`, that's a user action"), this delegation stopped before step 2 of the procedure.

## Pre-flight results
| # | Check | Result |
|---|---|---|
| 1 | `.env.local` contains `REDIS_CLUSTER=false` | ❌ **FAIL** — file exists (183 B, modified 2026-05-29 22:27), but no `REDIS_CLUSTER` line. Four keys are present (Redis connection URL, TLS flag, username, and a mis-spelled credential key). Values were not read or printed. |
| 2 | Connectivity probe (`scripts/connectivity-probe.mjs`) | ⏭ **NOT RUN** — gated behind check #1. |

## Per-step verdict
| Step | Description | Status |
|---|---|---|
| 1 | Pre-flight | ❌ FAIL (gate #1) |
| 2 | `docker compose down -v` + `up -d --build --wait` | ⏭ NOT RUN |
| 3 | `used_memory` baseline | ⏭ NOT RUN |
| 4 | Generator `--rows 2500 --classes GIRR,EQUITY,FX` | ⏭ NOT RUN |
| 5 | `sleep 30` | ⏭ NOT RUN |
| 6 | `used_memory` post-ingest (10 MB hard guard) | ⏭ NOT RUN |
| 7 | `FT.INFO idx:sens` (`num_docs ≥ 2250`) | ⏭ NOT RUN |
| 8 | `scripts/run-calc.sh` 6-variant matrix | ⏭ NOT RUN |
| 9 | `used_memory` pre-teardown | ⏭ NOT RUN |
| 10 | `docker compose down -v` | ⏭ NOT RUN |

## Calc 6-variant matrix
Not executed. Pre-flight aborted before any HTTP call was made.

## used_memory observations
| Phase | Bytes | Notes |
|---|---|---|
| Baseline | — | not captured (probe not run) |
| Post-ingest | — | not captured (ingest not run) |
| Pre-teardown | — | not captured (teardown not run) |
| **Peak used_memory** | **N/A** | **0 bytes consumed against the target DB this delegation — well under the 10 MB cap, but vacuously so.** |

## Cost-cap evidence (peak vs 10 MB)
Peak `used_memory` against `lip-veil-spring-32424.db.redis.io:14596` for this delegation: **0 B** (no client opened, no writes issued, no compose stack started). Hard cap of 10 MB was not approached. Row cap of 2,500 not approached (0 rows written). No loadgen invoked. Compose was not rebuilt.

## Repo hygiene
- `git diff --name-only services/` → **0 entries** under `services/*/src/`. No production code touched.
- This SUMMARY.md is the only file written.
- Secrets-clean: no secret values written. Connection-target hostname/port are quoted only because they appear in the task spec itself; no credentials, tokens, or connection strings appear.

## Recommended next step
User action required before the next delegation can proceed:

1. Add `REDIS_CLUSTER=false` to `.env.local` (the shared client at `shared/redis-client/src/index.ts:66` branches on this flag; without it, the smoke run cannot safely target the new standalone DB).
2. *(Optional / out of scope here)* The credential key in `.env.local` is misspelled (`...WROD` vs `...WORD`). Flagging only — not modified here per "no edits to `.env.local`" rule.
3. Once #1 is done, re-delegate this wave (or a successor) to repeat the pre-flight and proceed to the connectivity probe and 2.5k-row ingest.

## Outcome classification
🔴 **RED** (pre-flight failure). No retry attempted, per the task's "do NOT iterate" rule.
