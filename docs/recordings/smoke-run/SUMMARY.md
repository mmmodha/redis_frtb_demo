# Wave 4.8 — Path B Live Smoke Test SUMMARY

**Date:** 2026-05-27
**Workspace:** column-type
**Operator:** agent-6a14f103 (Wave 4.8 implementor)
**Verdict against ACs:** ❌ **BOTH FAIL — and the stack itself is non-functional at compose level. The 2 ⚠️ EXTRAPOLATED ACs cannot be converted to ✅ PROVEN; they convert to ❌ FALSIFIED.**

---

## TL;DR (honest)

The "Wave 4 verified GREEN" claim in the spec is contradicted by what `docker compose up` produces. Three of the seven service images are still placeholder/broken Dockerfiles, and the compose file has no Redis container at all by design (the bank perimeter assumption). Result: every Redis-touching code path (calc, observability, pivot, ingest, loadgen) returns HTTP 500 (`maxRetries`) after ~8 s. The two extrapolated ACs (`6 variants <2 s` and `200-user p99 <500 ms`) cannot be evaluated, because nothing is computing — they are timeouts, not work.

## Pre-flight

| Check | Result |
|---|---|
| `docker --version` | Docker version 29.5.2, build 79eb04c7d8 ✅ |
| `docker compose version` | v5.1.3 ✅ |
| `docker ps` (pre-up) | empty ✅ |

## 1. `docker compose up -d --wait`

| Metric | Value |
|---|---|
| Wall-clock | **25 s** (image cache hit from prior local builds; first-cold-pull would be longer) |
| Exit | **non-zero** — `container frtb-sbm-redis-pov-generator-1 is unhealthy` |
| Services healthy | api, ui, calc, source, ingest, loadgen (6/7) |
| Services unhealthy | **generator** — restart loop |

**Stack shape vs. task-note assumption:** Task note expected "3-node RE cluster + 7 services". Actual compose: **7 application services and zero Redis containers** (compose-file comment: *"Redis runs as Redis Enterprise Software inside the bank's perimeter and is configured via the UI Connections panel; no Redis container is started by this compose file."*). The `dev-redis` profile exists but is not part of the demo flow.

## 2. Observability — shard count

```
curl -sS http://localhost:8080/observability/shards
→ HTTP 500: "Reached the max retries per request limit (which is 3). Refer to maxRetriesPerRequest option for details."
```

**Primaries returned: 0** (AC required ≥3). The endpoint exists and is wired, but no Redis is reachable, so it 500s.

## 3. Generator (~10M rows)

**Did not run.** Generator container has a broken Dockerfile:

```
Error: Cannot find module '/app/src/index.mjs'
```

The `services/generator/Dockerfile` runs `node src/index.mjs`, but the implementation under `services/generator/src/` is TypeScript with no `.mjs` entrypoint. This is the same monorepo-entrypoint drift the spec already flags in *Non-blocking issues #1* for loadgen — except it's **also** affecting the generator (and, per inspection, the `calc` and `ui` Dockerfiles are still labeled "Placeholder Dockerfile … Real implementation replaces this in a later wave" and only serve `/healthz`).

| Metric | Value |
|---|---|
| Generation time | **N/A — container in CrashLoopBackOff** |
| Rows produced | 0 |

## 4. Six calc-variant wall-clock

All six variants ran against `POST /calc/sbm` on `localhost:8080`. Every call short-circuited on the Redis ioredis maxRetriesPerRequest (3) and returned HTTP 500 after ~8 s.

| Variant | HTTP | wall-clock (s) | K_b | <2 s AC |
|---|---|---|---|---|
| GIRR Delta   | 500 | 0.957 | — | ❌ (no result — error) |
| GIRR Vega    | 500 | 8.014 | — | ❌ |
| Equity Delta | 500 | 7.984 | — | ❌ |
| Equity Vega  | 500 | 7.994 | — | ❌ |
| FX Delta     | 500 | 7.993 | — | ❌ |
| FX Vega      | 500 | 7.975 | — | ❌ |

Raw responses in `calc-results.json`. The GIRR Delta number is shorter only because that one happened to retry less.

## 5. Loadgen — 200 user × 60 s

`POST /loadgen/start {"concurrency":200,"duration_sec":60,"mix":{pivot:0.5,calc:0.5}}`. SSE stream captured for 65 s into `loadgen-metrics.ndjson` (65 frames).

| Metric | pivot | calc | overall |
|---|---|---|---|
| Total requests | 804 | 796 | 1600 |
| Errors | 804 | 796 | **1600 (100 %)** |
| Throughput | — | — | 24.57 RPS |
| p50 latency | 7998 ms | 7998 ms | 7998 ms |
| p95 latency | 8012 ms | 8012 ms | 8012 ms |
| **p99 latency** | **8018.97 ms** | **8018 ms** | **8018.01 ms** |
| AC (p99 < 500 ms) | ❌ ~16× over | ❌ ~16× over | ❌ ~16× over |

These latencies are Redis-connection-retry timeouts (8 s = roughly the ioredis default retry strategy), **not** real work. The "real" p99 is unmeasurable from this run.

Mid-load observability screenshot: `screenshots/00-observability-mid-load.png` — captured but **blank**, because the ui container's Dockerfile is still a "Placeholder" that only serves `/healthz` (no React/Next app).

## 6. Playwright e2e against the live stack

**Skipped — by design choice in e2e/full-demo.spec.ts.** The spec hard-codes `page.route(...)` mocks for every API call (`/connections`, `/sources`, `/observability/*`, `/calc/sbm`, `/loadgen/*`, …) inside `installCommonRoutes(page)`. There is no `INTEGRATION` env flag, no conditional bypass. To run against the live stack we'd need to rewrite the spec — and the live UI container is a placeholder anyway, so it would not render the screens.

Manual fallback (per task note's allowance): I drove a stand-alone Playwright over the docker UI on `:3000` and captured 8 screenshots (`screenshots/00-…07-…`). All eight are functionally blank PNGs (5.7 KB each) because the UI container only exposes `/healthz`.

## 7. `docker compose down -v`

See bottom of this file — performed after writing SUMMARY.

---

## AC verdict (replaces the 2 ⚠️ rows in spec)

| Original ⚠️ row | Verdict from this run |
|---|---|
| **6 variants <2 s wall-clock on 10M rows** | ❌ **FALSIFIED** — 6/6 return HTTP 500 in ~8 s (Redis maxRetries). No data was generated; no Redis is running. |
| **200-user p99 <500 ms** | ❌ **FALSIFIED** — actual p99 = **8018 ms** (16× over), 100 % error rate. Latency is Redis-timeout, not real work. |

## Service health at end of run

| Service | State | Notes |
|---|---|---|
| api | healthy | only `/healthz` + non-Redis routes return; Redis routes 500 |
| ui | healthy | placeholder Dockerfile — only `/healthz` works |
| calc | healthy | placeholder Dockerfile — only `/healthz` works |
| source | healthy | ECONNREFUSED 127.0.0.1:6379 in logs |
| ingest | healthy (after warm-up) | ECONNREFUSED 127.0.0.1:6379 |
| loadgen | healthy | survived the 60 s drive |
| **generator** | **unhealthy — restart loop** | broken Dockerfile (`index.mjs` not found) |

## Findings to feed back into the spec / next wave

1. **The Wave 4 "verified GREEN" claim is mostly green on unit tests, not on the compose stack.** Three Dockerfiles need real-wave-up: `services/ui/Dockerfile`, `services/calc/Dockerfile`, `services/generator/Dockerfile` (CMD `index.mjs` vs. TS source).
2. **The compose file has no Redis, by design.** Any "live smoke test" claim needs to either (a) start the `dev-redis` profile, or (b) connect to a real Redis Enterprise endpoint via the Connections store, or (c) write the smoke test against a Testcontainers Redis. None of this happens automatically on `docker compose up`.
3. **The e2e spec is fully mocked.** It cannot serve as a "live demo proof". A separate INTEGRATION variant of the spec is needed if the goal is to drive the live stack.
4. **Task-note assumptions to correct:** "`localhost:3001`" should be `localhost:8080`; "`/loadgen/metrics/stream`" should be `/loadgen/metrics`; "3-node RE cluster" doesn't exist in the demo compose at all.

## Files produced (`docs/recordings/smoke-run/`)

```
SUMMARY.md                  ← this file
calc-results.json           ← 6 variants × {http, time_total_s, body}
loadgen-metrics.ndjson      ← 65 SSE frames
loadgen-summary.json        ← final /loadgen/status snapshot
screenshots/                ← 8 PNGs (00-07), all blank (UI is placeholder)
logs/                       ← compose-up.log, generator.log, source.log, api.log, ingest.log, loadgen.log, ui.log, ps-*.log
```
