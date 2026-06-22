# scripts/

Operational scripts for the FRTB demo. Service-level commands live in
`./run-local.sh`; the entries below are diagnostic helpers and one-shots.

## shard-balance-report.mjs (Wave 6.19)

Read-only health check answering "are the shards balanced at this scale?".

```bash
REDIS_URL='rediss://…' REDIS_CLUSTER=true \
  node --env-file=.env.local scripts/shard-balance-report.mjs
```

Outputs:

- **stdout**: single JSON object with per-shard rows + memory, per-tag
  counts + slot ownership, top-10 hottest tags, skew ratios, and a
  verdict line.
- **stderr**: human summary table for terminal use.
- **`.run/logs/shard-balance-<ISO>.json`**: machine-readable artifact for
  capacity-planning evidence.

**Verdict scale**:

- `balanced (skew < 1.5x)` — no action needed
- `mild skew (1.5-3x)` — worth a re-balancing conversation
- `severe skew (>3x)` — investigate hot tags + add bucket-weighting
- `single shard target — skew N/A` — running against a non-clustered
  target (proxy + 1 backend, or standalone Redis)

Read-only: `CLUSTER SLOTS`, `CLUSTER KEYSLOT`, `INFO memory`,
`FT.AGGREGATE … COUNT`. No writes, no `DEL`, no `DEBUG SLEEP`. Total
runtime budget: < 60s on a large clustered target at 100M.

## materialize-seen-sets.mjs (Wave 6.24)

One-shot SCAN over `sens:*` keys to populate the materialized discovery
sets (`seen:risk_class`, `seen:bucket:{<rc>}`, `seen:sens_type:{<rc>:<bkt>}`)
on a Redis target that pre-dates the Wave 6.24 ingest path. Idempotent —
SADD on an already-populated set is a no-op.

```bash
REDIS_URL='rediss://…' REDIS_CLUSTER=true SCAN_COUNT=1000 \
  node --env-file=.env.local scripts/materialize-seen-sets.mjs
```

Outputs a single JSON line with `scanned`/`applied`/`errors`/`elapsed_ms`.
Run-time budget: < 10 min on 100M `sens:*` keys (one SCAN per master with
pipelined SADDs).

Run BEFORE the first calc against a target that ingested data prior to
Wave 6.24 — otherwise calc's SMEMBERS-based discovery will return an
empty bucket set and the route reports `no-data-or-index`.

## finalise-rollups.mjs (Wave 7.0.3.A)

Post-load rollup finalisation — materialises the per-bucket rollup hashes
from bulk-loaded `sens:*` docs via FT.AGGREGATE against `idx:sens:slim`,
one query per `(risk_class, sensitivity_type)`. Writes tag-free
`rollup:<rc>:<bkt>:<sens>[:tenor:<t>]` keys (NO `{...}` hash tag) so the
rollup family spreads across every shard instead of pinning each bucket
onto one slot.

```bash
REDIS_URL='rediss://…' \
  node --env-file=.env.local scripts/finalise-rollups.mjs
```

Field shape mirrors the legacy incremental path
(`services/ingest/src/backfill-rollups.ts`) minus `sum_ws_up_sq` /
`sum_ws_down_sq` (verifier §3.2: never read by calc) and minus
`processed:*` markers (bulk path has no stream replay). Idempotent: HSET
overwrites the same fields on every re-run.

Outputs one JSON line on stdout (`rollups_written` / `empty_groups` /
`errors` / `elapsed_ms`) and per-`(rc, sens)` progress on stderr.
Run-time budget: < 5 min on 10M docs / 2-shard cluster.

## Other helpers

- `_check-xlen.mjs` — XLEN + XPENDING across the 16 hash-tag shard streams.
- `_flush-active-target.mjs` — FLUSHALL on the api's active target (auth
  via `$INTERNAL_API_TOKEN`).
- `_flush-cluster.mjs` — FLUSHALL across all masters on a cluster.
- `_summarize-profile.mjs` — Post-process `INGEST_PROFILE=1` output.
- `_z_xlen.mjs` — Compact XLEN sweep (debug variant).
- `capture-storyboard-shots.ts` — Playwright UI captures for asset packs.
- `clear-bootstrap-hash.ts` — Wipe the boot-skip schema hash so the next
  start runs the full bootstrap.
- `diagnose-cluster.sh` — Cluster connectivity sanity check.
- `run-local.sh` — Service orchestration (start/stop/restart). Use
  `./run-local.sh stop` instead of `kill -9` per the operational
  guardrails.
- `smoke-reset-cluster.sh` — Multi-shard FLUSHALL + bootstrap.
