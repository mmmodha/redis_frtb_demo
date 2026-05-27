# Wave 5.7 — Live smoke re-run (post-Wave 5.6 fixups) SUMMARY

**Date:** 2026-05-27
**Workspace:** column-type
**Operator:** agent-d284ce19 (Wave 5.7 implementor)
**Target:** user-provided Redis Enterprise 2-master cluster via `.env.local` (URL redacted; only metadata cited)
**Verdict against ACs:** ❌ **BOTH STILL FALSIFIED — new failure modes exposed by Wave 5.6. A Wave 5.8 fixup wave is required.**

---

## TL;DR (honest)

Wave 5.6 closed the three gaps it set out to (env_file pickup, generator schema, api bootstrap code path) but the smoke run exposed **four new gaps**:

1. **api bootstrap never fires.** `services/api/src/index.ts` calls `await redis.connect()` which throws `Error: Redis is already connecting/connected` (race against the shared client's eager-connect path). The `catch` sets `redisConnected=false`, which gates the `bootstrapFrtb()` block — so `idx:sens` is never created and the `frtb` Function library is never loaded. No `bootstrap:"idx:sens"` or `bootstrap:"frtb"` log lines are ever emitted on either fresh-up or restart.
2. **source + ingest crashloop with `ERR_MODULE_NOT_FOUND` for `@frtb/redis-client`.** Their Dockerfiles do not COPY `shared/redis-client` into the workspace, so the import fails at module-resolution time. Wave 5.6 fixed api/generator but did not fix source/ingest.
3. **Cluster arrives at OOM on first XADD.** The user's cluster still holds **455,804 rows / ~717 MB per shard (~1.43 GB total)** from a prior Wave 5.6.2 run (`docker compose down -v` does not flush a *remote* Redis cluster — only local volumes). The generator's very first XADD against this state returns `OOM command not allowed when used memory > 'maxmemory'` (the spec's documented diagnostic behavior) and the generator container then restart-loops, producing **0 new rows** this run.
4. **The 4 "HTTP 200" calc responses return `charge=0, per_bucket=[]`.** With `idx:sens` missing, `FT.AGGREGATE` hits a Redis Enterprise master that returns empty (not `SEARCH_INDEX_NOT_FOUND`) for some shards, so the route returns 200 with no per-bucket math. This passes the HTTP-status side of the AC but fails the spirit (non-zero `sbm_charge`).

Net effect: every calc-touching code path is still **non-functional for SBM compute**. The two open ACs cannot be claimed.

## Pre-flight

| Check | Result |
|---|---|
| `test -f .env.local` | ✅ exists |
| `docker --version` | Docker 29.5.2 ✅ |
| `docker compose version` | v5.1.3 ✅ |
| `docker compose config -q` | exit 0 ✅ |
| `docker ps` (pre-up) | empty ✅ |
| **`docker compose up -d --wait` (NO `--env-file`)** | ✅ env_file directive picked up (Wave 5.6.1 landed). api connected to user's 2-master cluster. |

## 1. `docker compose up -d --wait`

| Metric | Value |
|---|---|
| Wall-clock | **23 s** (cold image build for all 7 services on first up after rebuild) |
| Exit code | non-zero (compose reports `container source-1 is unhealthy`) |
| Services healthy | api, ui, calc, loadgen (4/7) |
| Services crashlooping | source, ingest, generator (3/7) |
| api → Redis connect log | `{"service":"api","status":"redis-unreachable","target":"env:REDIS_URL","err":"Error: Redis is already connecting/connected"}` followed by `{"service":"api","status":"ready",...}` — **bootstrap block silently skipped** |
| api → bootstrap logs | **NONE.** Expected `{"bootstrap":"idx:sens","nodes":2}` + `{"bootstrap":"frtb","functions":[…]}` — neither line present |
| source → crash | `Error: Cannot find package '/app/node_modules/@frtb/redis-client/index.js'` × indefinite |
| ingest → crash | same `ERR_MODULE_NOT_FOUND @frtb/redis-client` × indefinite |

## 2. Observability — shard count (AC step 4)

```
curl -sS http://localhost:8080/observability/shards
HTTP 200 in 0.403 s
```

```json
[
  {"shardId":"2","role":"master","opsPerSec":11,"slotCount":8192,"usedMemoryBytes":751819216,"netInBytes":424385489,"netOutBytes":447323991},
  {"shardId":"3","role":"master","opsPerSec":11,"slotCount":8192,"usedMemoryBytes":751819216,"netInBytes":424385489,"netOutBytes":447323991}
]
```

**Primaries returned: 2** (AC ≥2). ✅ Cluster reachability + Wave 5.2 wiring still good; full 0–16383 slot coverage. `usedMemoryBytes` per shard ≈ **716 MB** → cluster total ≈ **1.43 GB** of pre-existing data.

## 3. Generator — 2M rows attempt + OOM signature

The generator service auto-starts under compose. Schema + REDIS_URL are correctly resolved (Wave 5.6.2 landed): `{"totalRows":2000000,"classes":["GIRR","CSR_NON_SEC","CSR_SEC_NON_CTP","CSR_SEC_CTP","EQUITY","COMMODITY","FX"],"schemaPath":"/app/config/schema/frtb-default.yaml","stream":"sensitivities:in","msg":"generator starting"}`.

Every attempt fails on the **first** XADD:

```
{"level":50,"err":"ReplyError: OOM command not allowed when used memory > 'maxmemory'.",
  "msg":"generator failed"}
```

| Metric | Value |
|---|---|
| Generation wall-clock (per attempt) | **~1.6–2.1 s to first OOM** |
| Rows produced **this run** | **0** |
| `XLEN sensitivities:in` (entry / exit) | 455,804 / 455,804 (unchanged — prior Wave 5.6.2 residue) |
| `used_memory_human` (entry / exit) | 716.92 M / 717.36 M |
| `maxmemory_policy` | `volatile-lru` (and stream entries carry no TTL → eviction can't reclaim → OOM-on-overflow is the documented diagnostic) |
| Generator container status | `Restarting (1)` for the full smoke window |

**"What fits" number from Wave 5.6.2 (still resident in cluster):** **455,804 rows ≈ 717 MB per shard (1.43 GB cluster)** — this is the OOM ceiling on this 2-master cluster, ~23% of the 2 M-row default target. The cluster cannot hold 2 M rows; Wave 4's "2 M rows" architectural assumption needs either a larger shard budget, smaller-payload rows, or stream MAXLEN trimming.

## 4. Six calc-variant wall-clock — against the **post-OOM** data

Calls to `POST http://localhost:8080/calc/sbm` with `{"risk_class":"<RC>","sensitivity_type":"<L>"}`:

| Variant | HTTP | wall-clock | Body (truncated) | non-zero charge? | <2 s AC |
|---|---|---|---|---|---|
| GIRR Delta   | 200 | 0.392 s | `{"charge":0,"per_bucket":[],"total_ms":384.214,"shard_breakdown":[],"fanout_ms":0.017}` | ❌ zero | ✅ timing only |
| GIRR Vega    | 200 | 0.098 s | `{"charge":0,"per_bucket":[],"total_ms":93.153,...}` | ❌ zero | ✅ timing only |
| Equity Delta | 200 | 0.101 s | `{"charge":0,"per_bucket":[],"total_ms":97.371,...}` | ❌ zero | ✅ timing only |
| Equity Vega  | 500 | 0.098 s | `SEARCH_INDEX_NOT_FOUND Index not found: idx:sens` | ❌ error | ❌ |
| FX Delta     | 500 | 0.102 s | `SEARCH_INDEX_NOT_FOUND Index not found: idx:sens` | ❌ error | ❌ |
| FX Vega      | 200 | 0.101 s | `{"charge":0,"per_bucket":[],"total_ms":96.278,...}` | ❌ zero | ✅ timing only |

Raw responses in `calc-results.json`. The 200/500 split is non-deterministic: ioredis Cluster routes `FT.AGGREGATE` to a single master per call; both masters lack `idx:sens` (confirmed via `FT._LIST` returning empty on both 18.117.107.213:10395 and 16.59.25.183:10395), but Redis Enterprise's proxy returns either an empty result or `SEARCH_INDEX_NOT_FOUND` depending on which master is hit. Either way: **zero rows participate in SBM math**.

**AC verdict:** ❌ FALSIFIED. The AC requires "6 variants <2 s wall-clock on 2 M rows" — the timing side is met (<2 s on all 6), but (a) there are 0 M rows of real compute, not 2 M, and (b) `sbm_charge` is 0 on every variant. Per the task's own verification rule ("HTTP 200 with non-zero sbm_charge AT LEAST ONCE"), this is not met.

## 5. Loadgen — 200 user × 60 s

`POST /loadgen/start {"concurrency":200,"duration_sec":60,"mix":{"pivot":0.5,"calc":0.5}}`. SSE stream captured for 65 s into `loadgen-metrics.ndjson` (65 frames). Final `/loadgen/status` snapshot in `loadgen-summary.json`.

| Metric | pivot | calc | overall |
|---|---|---|---|
| Total requests | 58,370 | 58,366 | **116,736** |
| Errors | 28,925 | 29,142 | **58,067 (49.7 %)** |
| Throughput | — | — | **1,790 RPS** (full-window) |
| p50 latency | 98 ms | 98 ms | 98 ms |
| p95 latency | 113 ms | 113 ms | 113 ms |
| **p99 latency** | **174 ms** | **174 ms** | **174 ms** |
| AC (p99 < 500 ms) | ⚠️ numerically yes (174 < 500), but half the requests still 500 from missing idx:sens | — | ❌ cannot claim |

**Honest read:** p99 = 174 ms is well under the 500 ms AC. Throughput is 1,790 RPS (Wave 5.5 was 1,167; Wave 4.8 was 24.6). BUT 49.7 % of requests return 500 `SEARCH_INDEX_NOT_FOUND`, and the 50.3 % that "succeed" return `charge=0` over `per_bucket=[]`. The latency is the round-trip of (a) a 500-error path and (b) a 200-empty-result path — **not** SBM compute. The AC cannot be claimed.

Mid-load observability screenshot: `screenshots/08-observability-post-load.png` (45 KB — real UI render).

## 6. Playwright E2E against the live stack (`INTEGRATION=1 npm run test:e2e:live`)

| Result | Value |
|---|---|
| Spec | `e2e/full-demo.spec.ts` |
| Mode | `INTEGRATION=1` (mocks bypassed — Wave 5.3 deliverable) |
| Test outcome | **❌ 1 failed (5.3 s)** |
| First successful step | Step 02 (architecture landing) — screenshot captured |
| First failed step | Step 02a (Connections panel) — `getByText('demo-cluster')` not visible (5 s timeout) |
| Trace + failure screenshot | `playwright-artifacts/` (trace.zip + test-failed-1.png + error-context.md) |
| Reason | Same as Wave 5.5: no seeded `demo-cluster` / `scale-cluster` connection profiles. `SEED_CONNECTIONS_FILE` still not wired into the compose api block. |

**No assertion relaxation.** The failed trace is captured for the Wave 5.8 fixup (same finding as Wave 5.5 #6 — not yet addressed).

## 7. Service health at end of run

| Service | State | Notes |
|---|---|---|
| api | healthy | connects (with race-error log); serves /healthz, /observability/shards, /calc/sbm (returns 200/500 mix); **bootstrap never fired** |
| ui | healthy | real Vite/React build, 45–86 KB screenshots |
| calc | healthy | `/healthz` only — api owns SBM orchestration |
| loadgen | healthy | drove 116,736 reqs in 65 s |
| **source** | **crashlooping** | `ERR_MODULE_NOT_FOUND @frtb/redis-client` — Dockerfile missing |
| **ingest** | **crashlooping** | same `ERR_MODULE_NOT_FOUND @frtb/redis-client` |
| **generator** | **crashlooping** | OOM-on-overflow on first XADD against pre-loaded cluster |

## AC verdict (replaces the 2 ❌ FALSIFIED rows in the spec)

| AC | Verdict from this run |
|---|---|
| **6 variants <2 s wall-clock on 2 M rows** | ❌ **STILL FALSIFIED.** Timing side met (max 0.392 s) but: (a) 0 new rows ingested this run (cluster at OOM); (b) `idx:sens` never created (api bootstrap skipped due to redis-connect race); (c) every variant returns `charge=0` (4×200 empty + 2×500 SEARCH_INDEX_NOT_FOUND). No SBM compute occurred. Per the task's own verification rule ("non-zero `sbm_charge` AT LEAST ONCE"): not met. |
| **200-user p99 <500 ms** | ❌ **STILL FALSIFIED.** Measured **p99 = 174 ms** across **116,736 requests @ 1,790 RPS** with **49.7 % error rate** (`SEARCH_INDEX_NOT_FOUND`). Even the 50.3 % "successes" return `charge=0` over empty per_bucket. Numerically under threshold but does not measure SBM compute — same falsification class as Wave 5.5 (50 % error rate instead of 100 %; substantive verdict identical). |

## Wave-on-Wave comparison

| Dimension | Wave 4.8 | Wave 5.5 | **Wave 5.7** |
|---|---|---|---|
| compose-up wall-clock | 25 s | 7 s | 23 s (rebuild on all images) |
| `.env.local` pickup | ❌ needed `--env-file` | needs `--env-file` flag | ✅ env_file directive picks up automatically (Wave 5.6.1) |
| Generator container | broken (`index.mjs` not found) | broken (`SCHEMA_FILE` missing) | **runs the CLI** but crashes on cluster OOM (Wave 5.6.2 landed schema/COPY) |
| api `bootstrap` block | not present | not present | present in code (Wave 5.6.3) but **silently skipped at runtime** (race) |
| `idx:sens` on cluster | absent | absent | **still absent** |
| `frtb` Function library | absent | absent | **still absent** |
| source/ingest containers | (didn't test deeply) | source warm-up errors; ingest MOVED errors then stabilises | **both crashloop** (`ERR_MODULE_NOT_FOUND @frtb/redis-client`) — Wave 5.6 regression or pre-existing-unnoticed |
| 6-variant calc | 6×~8 s, 6/6 HTTP 500 | 6×~0.1 s, 6/6 HTTP 500 | 6×~0.1–0.4 s, **4/6 HTTP 200 (charge=0)**, 2/6 HTTP 500 — *new* mixed-mode failure |
| Loadgen p99 | 8018 ms | 157 ms | 174 ms |
| Loadgen error rate | 100 % | 100 % | **49.7 %** |
| Loadgen RPS | 24.6 | 1,167 | **1,790** |
| AC #1 (calc <2 s) | ❌ FALSIFIED | ❌ FALSIFIED | ❌ FALSIFIED |
| AC #2 (p99 <500 ms) | ❌ FALSIFIED | ❌ FALSIFIED | ❌ FALSIFIED |

## Wave 5.8 candidate list

1. **Fix api bootstrap race** (`services/api/src/index.ts`). The shared `createRedisClient(...)` already eager-connects (or queues a connect); the explicit `await redis.connect()` then throws `Redis is already connecting/connected`, the catch sets `redisConnected=false`, and `bootstrapFrtb()` is skipped. Fix: either drop the explicit `connect()` (rely on shared client's connect), or treat the "already connecting/connected" error string as success, or use `redis.status === "ready"` instead of a boolean from the try/catch. **Highest-impact fix — unblocks every Wave 4 AC.**
2. **Add `shared/redis-client` to source + ingest Dockerfiles** so `@frtb/redis-client` resolves at runtime. Mirror api's `COPY shared/redis-client ./shared/redis-client` + `npm install --workspaces` step. (api + generator Dockerfiles already do this — services/source + services/ingest do not.)
3. **Handle pre-existing cluster state.** The user's cluster persists between runs and `docker compose down -v` only removes local volumes. Options: (a) generator `FLUSHALL` before producing (destructive; risky on a shared cluster), (b) generator uses `XADD … MAXLEN ~ <cap>` to self-trim, (c) document an operator `redis-cli -u "$REDIS_URL" -c FLUSHALL` step before each smoke run, (d) lower the generator default from 2 M to ~400 k to match what fits in this 1.4 GB cluster. (c) is least invasive but should be in the task notes / Makefile.
4. **Seed connection profiles for `INTEGRATION=1` e2e.** Same as Wave 5.5 finding #6 — add `SEED_CONNECTIONS_FILE` env or a `beforeAll` POST. Spec assertion at `e2e/full-demo.spec.ts:199` correctly catches the gap.
5. **`/calc/sbm` should fail loudly when `per_bucket=[]`.** A 200 response with `charge=0` and `per_bucket=[]` is indistinguishable from "valid but empty risk class" — but in this run it actually means "idx:sens is missing on the master we routed to". Either pre-flight check `FT._LIST` at startup and refuse to start without `idx:sens`, or return 503 when `per_bucket=[]` AND the rest of the cluster has rows for `risk_class`.
6. **Document the OOM ceiling.** 455,804 rows ≈ 1.43 GB on this cluster is **23 % of the 2 M-row default**. Either (a) downsize generator default, (b) shrink per-row payload, or (c) call out in the spec that 10 M-row AC needs a 4+ shard cluster (linear scale-out).

## Files produced (`docs/recordings/smoke-run-3/`)

```
SUMMARY.md                              ← this file
calc-results.json                       ← 6 variants × {http, time_total_s, body}
loadgen-metrics.ndjson                  ← 65 SSE frames
loadgen-summary.json                    ← final /loadgen/status snapshot (p99=174 ms, errors=49.7 %)
screenshots/                            ← 8 PNGs (01-08, all real renders, 45–86 KB)
e2e-step-screenshots/                   ← step-02-architecture-landing.png (last successful before assertion failed)
playwright-artifacts/                   ← failed-e2e trace.zip + test-failed-1.png + error-context.md
scripts/                                ← run_calc.sh, sse-capture.mjs, smoke-shots.mjs
logs/                                   ← compose-up.log, compose-down.log, api.log, ingest.log, source.log, calc.log, generator.log, ui.log, ps-final.log, observability-shards.json, observability-shards-post.json, loadgen-start.json, e2e-live.log, screenshots.log, api-post-restart.log
```

## Reproducer

```bash
# pre-flight
test -f .env.local && echo "ENV_OK"
docker compose config -q && echo "CONFIG_OK"

# bring stack up (NO --env-file flag — Wave 5.6.1)
docker compose up -d --wait

# inspect bootstrap (will show ZERO bootstrap log lines — the bug)
docker compose logs api | grep -E "bootstrap|redis-unreachable|status"

# step 4 — shard count
curl -sS http://localhost:8080/observability/shards | jq .

# step 5 — generator (will OOM on first XADD against pre-loaded cluster)
docker compose logs generator | tail -20

# step 6 — six calc variants
bash docs/recordings/smoke-run-3/scripts/run_calc.sh

# step 7 — loadgen 200×60
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"concurrency":200,"duration_sec":60,"mix":{"pivot":0.5,"calc":0.5}}' \
  http://localhost:8080/loadgen/start
node docs/recordings/smoke-run-3/scripts/sse-capture.mjs 65000

# step 8 — live e2e (still fails at step 02a — same as Wave 5.5)
INTEGRATION=1 npm run test:e2e:live

# teardown
docker compose down -v
```
