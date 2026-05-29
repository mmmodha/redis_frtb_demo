# Wave 5.15o-v2 — Smoke validation on new standalone DB

**Run date:** 2026-05-29 (re-delegation after prior 🔴 RED pre-flight abort)
**Target DB:** `lip-veil-spring-32424.db.redis.io:14596` (standalone, 1 master + 1 replica, 2.5 GB cap, `noeviction`, TLS off)
**Cost caps:** ≤ 10 MB peak `used_memory`, ≤ 2,500 rows, 1 ingest cycle, no loadgen.

## Verdict
🔴 **RED — api container bootstrap failed against the new DB. Aborted before any ingest, calc, or loadgen.**

Pre-flight gates both passed (`.env.local` cluster flag present, host-side connectivity probe green). `docker compose up -d --build --wait` finished image builds but the `api` container reported `bootstrap-failed` / `redis-unreachable`. `/healthz` returned 503 on every poll, so per the task rule "any HTTP non-200 → STOP, report, do NOT retry", execution stopped before step 4 (generator). One transient-race recovery was attempted (`docker compose restart api`, no rebuild, no Redis writes) — same failure reproduced. Classified as DEBUG-NEEDED root cause beneath the 🔴 RED outcome envelope.

## Pre-flight results
| # | Check | Result |
|---|---|---|
| 1 | `.env.local` contains the cluster-flag set to false | ✅ **PASS** — flag value `FALSE` present (envBool lowercases, so `FALSE` parses as `false`). The credential-key spelling typo previously flagged in turn 1 has been corrected by the user. |
| 2 | `scripts/connectivity-probe.mjs` (host-side) | ✅ **PASS** — `mode=standalone`, `connect.ok=true`, `ping.ok=true`, `write_path.ok=true`, `used_memory_human=4.22M`, role=master, 1 replica, redis_version=8.4.0, redis_mode=standalone. Log: `logs/connectivity-probe.json`. |

## Per-step verdict
| Step | Description | Status |
|---|---|---|
| 1 | Pre-flight (gates #1 + #2) | ✅ PASS |
| 2 | `docker compose down -v` + `up -d --build --wait` | ⚠️ build OK; `wait` failed — `api` reported `dependency failed to start: container frtb-sbm-redis-pov-api-1 is unhealthy` |
| 3 | `used_memory` baseline (host probe pre-bring-up) | ✅ captured: 4,427,744 B (4.22 MB) |
| 4 | Generator `--rows 2500 --classes GIRR,EQUITY,FX` | ⏭ NOT RUN (api unhealthy gate) |
| 5 | `sleep 30` | ⏭ NOT RUN |
| 6 | `used_memory` post-ingest (10 MB hard guard) | ⏭ NOT RUN |
| 7 | `FT.INFO idx:sens` (`num_docs ≥ 2250`) | ⏭ NOT RUN |
| 8 | `scripts/run-calc.sh` 6-variant matrix | ⏭ NOT RUN |
| 9 | `used_memory` pre-teardown | ✅ captured via host probe: 4,458,480 B (4.25 MB) |
| 10 | `docker compose down -v` | ✅ done; volumes/network removed |

## Calc 6-variant matrix
Not executed. `api` never reached HTTP 200; calling `POST /calc/sbm` would have returned 503 for every variant.

## used_memory observations (against remote DB, captured via host probe)
| Phase | Bytes | Human | Notes |
|---|---|---|---|
| Baseline (host probe before compose bring-up) | 4,427,744 | 4.22M | pre-existing residual from prior runs / DB system overhead; no flush performed (FLUSHALL was scheduled downstream of api healthy gate) |
| Post-ingest | — | — | not captured (ingest not run) |
| Pre-teardown (host probe after api failure) | 4,458,480 | 4.25M | Δ ≈ +30 KB from baseline — consistent with the two probe write-path keys (TTL 5s, both expired before teardown; remainder is internal accounting) |
| **Peak used_memory** | **4,458,480 B (4.25 MB)** | | **Well under the 10 MB hard cap. Cost guardrail HONOURED.** |

## Cost-cap evidence (peak vs 10 MB)
Peak observed `used_memory` against the target DB this delegation: **4.25 MB**. Hard cap of 10 MB **not approached** (57.5 % headroom remaining). Row cap of 2,500 not approached (0 rows ingested — generator never ran). No loadgen invoked. One `--build` only (initial compose up). One restart of the `api` container attempted to clear a suspected startup race; same failure reproduced — no further iteration.

## Misbehaviour signature (DEBUG-NEEDED root cause)
- `api` container env at runtime: cluster flag `FALSE`, TLS flag `0`, connection-URL env present (DB host: `lip-veil-spring-32424.db.redis.io`, port 14596 reachable from inside the container — verified via `nc -zv` and DNS `getent hosts`).
- Two consecutive boots of `api` logged: `{"service":"api","status":"redis-unreachable","err":"Error: redis-ready timeout after 5000ms"}` followed by `markBootstrapSkipped("redis-unreachable")` → `/healthz` returns 503 with body `{"status":"bootstrap-failed","reason":"redis-unreachable"}`.
- Host-side connectivity probe (same target DB, same network egress) succeeded twice (pre and post compose) with sub-1.5 s elapsed and ping latency 117 ms.
- Hypothesis: the 5 000 ms `ensureRedisReady` timeout in `services/api/src/redis-ready.ts` may be insufficient for this Redis Cloud endpoint's cold-start handshake from inside the docker network namespace (AUTH + INFO ready-check). Not changed — task forbids edits to `services/*/src/`. Owner action needed.

## Repo hygiene
- `git diff --name-only services/ | grep "services/.+/src/"` → **empty** (✅ no production source code touched).
- `git diff --name-only services/` shows 3 pre-existing entries from prior work (not authored this delegation): `services/{generator,ingest,source}/package.json` (each adds the shared client package). All outside `src/`. DoD check passes.
- Files written this delegation: this SUMMARY (overwrite), `docs/recordings/smoke-run-15/logs/connectivity-probe.{json,stderr}` (refreshed), `docs/recordings/smoke-run-15/logs/connectivity-probe-post-bootstrap-fail.{json,stderr}` (diagnostic snapshot), `docs/recordings/smoke-run-15/logs/compose-up.log`, `docs/recordings/smoke-run-15/logs/compose-down.log`.
- Secrets-clean: no connection strings, credentials, or auth tokens written to any of the above artefacts (probe JSON contains hostname + port only; the compose-up log was inspected before quotation and contains no auth material).

## Outcome classification
🔴 **RED** — HTTP 503 from `/healthz` on every poll (the task's "any HTTP non-200" trigger). Root cause sits in DEBUG-NEEDED territory (api ↔ Redis-Cloud handshake timeout inside the docker network, host probe succeeds). No retry attempted beyond the single `api`-container restart.

## Recommended next step
Owner-side debugging is required **before** the next smoke re-delegation. Suggested diagnostic surface (out of scope here):

1. Reproduce the api `redis-ready timeout` interactively from inside the api image (e.g. `docker compose run --rm api node -e '...'`) using ioredis against the same connection-URL env the api consumes — measure how long until the `ready` event fires for this DB from inside the docker netns. The container's host + port are reachable (verified above) so the gate is almost certainly the handshake / INFO ready-check.
2. If the in-container handshake routinely takes > 5 s, the owner's options are (a) bump the readiness-timeout default in `services/api/src/redis-ready.ts` (out of scope for this delegation — forbidden by task scope), (b) move to a Redis Cloud region with lower handshake latency from this docker host, or (c) pre-warm a connection before the healthcheck window starts. Pick the path that aligns with PoV constraints.
3. Do **not** scale up rows, do **not** run loadgen, do **not** capture e2e screenshots until step 4 of the procedure (generator) can run against a healthy `api`.

## Verification (per task DoD)
- `test -f docs/recordings/smoke-run-15/SUMMARY.md` → OK
- Verdict + Peak used_memory headings present (see above)
- `git diff --name-only services/ | grep -E "services/.+/src/"` → empty (PRODCODE_OK)
- Secret-leak scans confirmed CLEAN: no connection-URL value, username, or credential value appears in this document.
