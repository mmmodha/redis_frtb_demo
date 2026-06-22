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

## finalise-seen-sets.mjs (Wave 7.0.3.B)

Post-load seen-set finalisation — materialises the discovery sets
(`seen:risk_class`, `seen:bucket:<rc>`, `seen:sens_type:<rc>:<bucket>`)
from bulk-loaded `sens:*` docs via a single FT.AGGREGATE GROUPBY against
`idx:sens:slim`. Writes **tag-free** keys (drops `{...}` vs the legacy
incremental path) so the seen-set family spreads across every shard
instead of pinning each `(rc, bucket)` onto one slot.

```bash
REDIS_URL='rediss://…' \
  node --env-file=.env.local scripts/finalise-seen-sets.mjs
```

Run AFTER `finalise-rollups.mjs` on a tag-free bulk-loaded DB. Idempotent:
SADD on an already-populated set is a no-op. Distinct from the legacy
`materialize-seen-sets.mjs` which writes hash-tagged key names for the
pre-Wave-7.0 stream-replay path.

Outputs one JSON line on stdout (`triples` / `risk_classes` / `buckets` /
`sens_types` / `errors` / `elapsed_ms`) and per-step progress on stderr.
Run-time: a single FT.AGGREGATE round-trip plus one SADD pipeline.

## calc-smoke-1k.mjs (Wave 7.0.6.7)

Tiny end-to-end smoke that validates the post-Wave-6.6 tag-free key shapes
(`rollup:<rc>:<bkt>:<sens>[:tenor:<t>]`, `seen:bucket:<rc>`,
`seen:sens_type:<rc>:<bkt>`) actually drive `/calc/sbm` to a non-zero charge
on a real 1K-row dataset. Catches deploy mismatches (writer on tag-free,
reader on tag-wrapped) that unit parity tests can't see.

```bash
REDIS_URL='redis://…' node scripts/calc-smoke-1k.mjs \
  [--redis URL] [--api-base URL] [--rows N] [--risk-class RC] [--sens TYPE]
```

Flow: FLUSHDB → POST `/api/admin/flush` (rebuilds indexes) → HSET 1000 slim
`sens:<id>` docs across GIRR + EQUITY × {Delta, Vega, Curvature} × 3 buckets
→ `finalise-rollups.mjs` → `finalise-seen-sets.mjs` → POST `/api/calc/sbm` →
assert HTTP 200, `per_bucket` non-empty, at least one bucket with K_b > 0,
no NaN/null/undefined, total charge > 0 and finite.

Defaults: `--api-base http://localhost:3000` (UI proxy, forwards `/api/*` to
the underlying API on :8080), `--risk-class GIRR`, `--sens Delta`,
`--rows 1000`. Exits 0 with `smoke OK · risk_class=… · sens=… · buckets=… ·
total_charge=…`; non-zero with the full response body dumped to stderr.

## diagnose-ingest.mjs (Wave 7.0.6.8)

Operator-side ingest throughput profiler. Pre-flight by default (no
writes): probes Redis, `idx:sens:slim`, bulk-loader, and api; prints a
`MODE=bulk-loader|stream-only|unknown` verdict. With `--probe --yes`,
FLUSHDBs the target and drives two 30s windows (stream via
`/api/generator/start`, then bulk-loader via `/load/rows`) to diagnose
INDEXER / HSET / CONNECTION-POOL / STREAM-CONSUMER / SINGLE-SHARD
bottlenecks; FLUSHDB cleanup runs between and after windows.

```bash
REDIS_URL='redis://…' node scripts/diagnose-ingest.mjs                 # pre-flight only
REDIS_URL='redis://…' node scripts/diagnose-ingest.mjs --probe --yes   # 60s controlled probe
```

## dev-up-and-diagnose.sh (Wave 7.0.6.9)

One-shot operator entrypoint that stops the local stack, rebuilds the UI
bundle, restarts every service (incl. bulk-loader on :8086), ensures the
api's active target points at `localhost:12000`, waits for
`/admin/index-count` to expose a live `index_name`, then runs
`diagnose-ingest.mjs --probe --yes` and tees output to
`logs/diagnose-ingest-<UTC>.log`.

```bash
./scripts/dev-up-and-diagnose.sh
```

Pre-requisites: `.env.local` with `REDIS_USERNAME` / `REDIS_PASSWORD`, and
Redis Enterprise already listening on `localhost:12000` (docker compose
up). The script never starts docker; it fails clean with a clear message
if RE is unreachable. Thin wrapper over `run-local.sh` — does not
reimplement service orchestration.

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
