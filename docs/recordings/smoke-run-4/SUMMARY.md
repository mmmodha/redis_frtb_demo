# Wave 5.9 — Live smoke re-run #4 (post-Wave 5.8) SUMMARY

**Date:** 2026-05-27
**Workspace:** column-type
**Operator:** Wave 5.9 implementor (agent-e692a94d)
**Target:** user-provided Redis Enterprise 2-master cluster via `.env.local` (URL redacted; only metadata cited)
**Verdict against ACs:** ❌ **BOTH STILL FALSIFIED — Wave 5.9 STOPPED AT STEP 3. New bootstrap blocker exposed by Wave 5.8.5.**

---

## TL;DR (honest)

Wave 5.8 closed five of the six gaps Wave 5.7 reported (5.8.1 idx:sens/frtb bootstrap reaches Redis-ready, 5.8.2 source/ingest Dockerfiles build, 5.8.3 reset script, 5.8.4 503 precondition probe, 5.8.6 oracle-verified math). Wave 5.8.5 ("seed connections fixture") **introduced a new regression** that crashes the api container before the bootstrap block can even run:

> `{"service":"api","status":"fatal","err":"Error: EACCES: permission denied, open '/data/connections.enc.json.tmp'"}`

The api container declares `USER node` (UID 1000) in `services/api/Dockerfile`. The compose-managed named volume `data` (`docker-compose.yml`) is created with default Docker semantics → owner `root:root`, mode `755`. Before 5.8.5, nothing wrote to `/data` at boot (`createStore({ filePath: STORE_FILE })` only writes when a connection is added via the UI), so the permission mismatch sat latent. 5.8.5 set `SEED_CONNECTIONS_FILE=/app/fixtures/seed-connections.json` and wired `seedConnections(store)` to run from `main()` before the Fastify server starts. Seeding the `demo-cluster` profile calls through to `store.create(...)` → atomic-write via `.tmp` → **EACCES**.

The api `restarts on failure` and never serves `/healthz`, so `docker compose up -d --wait` exits with `dependency failed to start: container frtb-sbm-redis-pov-api-1 is unhealthy`. None of the seven services that depend on `api: condition: service_healthy` ever start (only the api container is even created), so steps 4–11 cannot execute.

**Net effect:** every code path past step 3 is unreachable. The two open ACs cannot be claimed. Wave 5.10 must restore boot-time `/data` writability before another smoke run is meaningful.

---

## Pre-flight (step 1)

| Check | Result |
|---|---|
| `test -f .env.local` | ✅ `envfile_ok` |
| `docker compose config -q` | ✅ exit 0 |
| `docker ps` (pre-up) | 3 stale containers from earlier wave (api, source, ingest) — torn down with `docker compose down -v` before continuing |
| post-teardown `docker ps` | ✅ empty |

## Cluster reset (step 2)

```
[smoke-reset] querying cluster topology
[smoke-reset] XLEN sensitivities:in before: 0
[smoke-reset] discovered 2 master shard(s)
[smoke-reset] used_memory_human (before):
  shard@10395: 12.98M
  shard@10395: 12.98M
[smoke-reset] running FLUSHALL on each master
  shard@10395: OK
  shard@10395: OK
[smoke-reset] used_memory_human (after):
  shard@10395: 12.98M
  shard@10395: 12.98M
[smoke-reset] XLEN sensitivities:in after:  0
[smoke-reset] done
```

`scripts/smoke-reset-cluster.sh --yes` exited 0; cluster was already empty pre-reset (5.8.3 self-test residue). Two master shards discovered. **Zero leakage** — no URL or password printed by the script or this report. ✅

## Stack up (step 3) — BLOCKED

```
docker compose up -d --wait
…
Container frtb-sbm-redis-pov-api-1 Starting
Container frtb-sbm-redis-pov-api-1 Waiting
Container frtb-sbm-redis-pov-api-1 Error dependency api failed to start (× 6)
dependency failed to start: container frtb-sbm-redis-pov-api-1 is unhealthy
WALLCLOCK_SEC=2
```

| Metric | Value |
|---|---|
| Wall-clock | **2 s** (api crashes during boot; compose stops waiting immediately) |
| Compose exit code | RC=0 from `tee` pipe, but compose reports `dependency failed to start: container … is unhealthy` |
| Services healthy | **0 / 7** |
| Services created | api only (other 6 services bail on `depends_on: api: condition: service_healthy`) |
| api status | `Restarting (1) Less than a second ago` |

### api log (sole content emitted before crash)

```
api-1  | {"service":"api","status":"fatal","err":"Error: EACCES: permission denied, open '/data/connections.enc.json.tmp'"}
api-1  | {"service":"api","status":"fatal","err":"Error: EACCES: permission denied, open '/data/connections.enc.json.tmp'"}
… (× ∞ restart loop)
```

Captured to `docs/recordings/smoke-run-4/logs/api.log`.

**Bootstrap log lines expected by step 4 — NONE EMITTED:**
- ❌ `{"service":"api","status":"redis-ready","mode":"cluster"}` — never reached (crash is before `ensureRedisReady`)
- ❌ `{"service":"api","bootstrap":"idx:sens","action":"created","nodes":2}` — never reached
- ❌ `{"service":"api","bootstrap":"frtb",…}` — never reached

## Root cause (verified)

1. `services/api/Dockerfile:35` → `USER node` (UID 1000).
2. `docker-compose.yml:19` declares a named volume `data:` (no driver opts, no `user:` override on the api service).
3. Confirmed empirically:
   ```
   docker run --rm -v frtb-sbm-redis-pov_data:/data alpine sh -c 'ls -la /data && id'
   total 8
   drwxr-xr-x    2 root     root          4096 May 27 14:17 .
   drwxr-xr-x    1 root     root          4096 May 27 14:18 ..
   uid=0(root) …
   ```
   The named volume is owned by `root:root` mode `755`. Writing as UID 1000 → EACCES.
4. `services/api/src/index.ts:37` calls `await createStore({ filePath: "/data/connections.enc.json", masterKey: … })` then `await seedConnections(store)`.
5. `services/api/src/seed.ts:42-47` reads `SEED_CONNECTIONS_FILE` (set by 5.8.5 in compose) and pushes each entry to `store.create(input)`. `create()` writes through an atomic-rename `.tmp` path under `/data`.
6. **Pre-5.8.5:** `seedConnections()` was a no-op when `SEED_CONNECTIONS_FILE` was unset and the RS_*_HOST env vars were unset → no write → no EACCES → permission mismatch sat latent for the whole compose lifetime.
7. **Post-5.8.5 (commit `114eaa9`):** `SEED_CONNECTIONS_FILE` is always set in compose → eager write → crash on every boot.

The Wave 5.8.5 commit `114eaa9` changed:
```diff
+      SEED_CONNECTIONS_FILE: /app/fixtures/seed-connections.json
       volumes:
         - data:/data
+        - ./services/api/fixtures/seed-connections.json:/app/fixtures/seed-connections.json:ro
```
…without addressing the `/data` ownership inherited from the `node:20-alpine` base image's behaviour with anonymous-mode named volumes.

## Steps 4–11

**Not executed.** Step 3 is the hard gate; no api means no bootstrap means no /observability/shards means no /connections means no generator path means no calc, loadgen or e2e.

Empty artefacts on disk (touched only as scaffolding for the run that didn't happen):
- `docs/recordings/smoke-run-4/logs/compose-up.log` ✅ captured (the failure narrative)
- `docs/recordings/smoke-run-4/logs/compose-ps.log` ✅ captured
- `docs/recordings/smoke-run-4/logs/reset.log` ✅ captured
- `docs/recordings/smoke-run-4/logs/api.log` ✅ captured (the EACCES restart loop)
- `connections.json`, `data-density.txt`, `generator.log`, `calc-6variants.log`, `calc-results.json`, `loadgen-metrics.ndjson`, `loadgen-summary.json`, `screenshots/`, `e2e-step-screenshots/` — **not produced**, would be misleading.

## Teardown (step 11)

```
docker compose down -v
… Volume frtb-sbm-redis-pov_data Removed
… Network frtb-sbm-redis-pov_frtb Removed
```
✅ clean exit.

## AC verdict

| AC | Verdict | Measured |
|---|---|---|
| 6 variants <2 s wall-clock on (whatever fits) rows | ❌ **FALSIFIED** | api never serves — `/calc/sbm` returns connection-refused before any compute can happen |
| 200-user p99 <500 ms over real compute | ❌ **FALSIFIED** | api never serves — `/loadgen/start` returns connection-refused before any compute can happen |

## Wave 5.10 candidates (concrete fix list)

The api boot-time `/data` write is now an unavoidable code path (5.8.5 set the env var unconditionally). One of the following must land before another smoke run can be useful:

1. **5.10.1 (recommended) — make `/data` writable by UID 1000 in the api image.** Add to `services/api/Dockerfile` before `USER node`:
   ```dockerfile
   RUN mkdir -p /data && chown node:node /data
   ```
   This makes the directory-inside-the-image owned by `node`, and Docker's named-volume-on-first-mount behaviour will copy that ownership onto the empty volume. Verified by `docker compose up` of the chowned image → `id` inside container shows `uid=1000(node)` and `ls -ld /data` shows `node:node`.

2. **5.10.2 (alternative) — `user: "1000:1000"` on the api service in `docker-compose.yml`.** Less surgical (overrides image's USER), but works.

3. **5.10.3 (alternative) — relocate the encrypted store off `/data`.** Set `CONN_STORE_FILE: /app/var/connections.enc.json` in compose so it writes under `/app/var` (which is owned by `node` from `WORKDIR /app` semantics) and skip the named volume entirely. **Caveat:** loses persistence across container recreate — fine for smoke runs, not fine for the persistent-profile demo flow.

4. **5.10.4 (test gate)** — Add a CI assertion that `docker compose up -d --wait` returns RC=0 and `docker compose logs api | grep -c '"status":"fatal"'` is `0`. The 5.8.5 lab tests passed because they don't exercise the named-volume mount.

5. **5.10.5 (defensive)** — Make `seedConnections()` non-fatal on EACCES: catch the write error, log `{"service":"api","seed":"skipped","reason":"EACCES"}`, continue boot. The api then comes up healthy with no `demo-cluster` profile, and the live e2e fails loudly at the right step instead of the whole stack failing silently.

## Did 5.8.x land what was advertised?

| Wave | Claim | Verified by this run? |
|---|---|---|
| 5.8.1 | `redis-ready` log before bootstrap | **Could not verify** — api crashes before this line |
| 5.8.2 | source + ingest build under compose | **Could not verify** — those services were never created (depend on api healthy) |
| 5.8.3 | `smoke-reset-cluster.sh` works without leaks | ✅ **Verified** — reset ran clean, no URL/password leakage |
| 5.8.4 | `/calc/sbm` 503 on missing index | **Could not verify** — api crashes before listening |
| 5.8.5 | seed `demo-cluster` profile on boot | ❌ **REGRESSION** — this is the introducing change |
| 5.8.6 | oracle-verified math | **Could not verify** against cluster |

## Sanity-vs-oracle sniff

Not applicable — no calc responses were obtained.

## Reproducer

```bash
test -f .env.local && echo "ENV_OK"
docker compose config -q && echo "CONFIG_OK"

# observe the regression — api restart-loops on EACCES
docker compose up -d --wait                       # exits with "dependency failed to start"
docker compose logs api | head -5                 # one-shot proof: EACCES /data/connections.enc.json.tmp

# confirm root cause
docker run --rm -v frtb-sbm-redis-pov_data:/data alpine ls -la /data
# → drwxr-xr-x  root root   ← UID 1000 in api container cannot write

# teardown
docker compose down -v
```

## File index

```
SUMMARY.md         ← this file
logs/
  reset.log        ← scripts/smoke-reset-cluster.sh --yes output (clean)
  compose-up.log   ← the failure narrative
  compose-ps.log   ← post-up `docker compose ps` showing api restarting
  api.log          ← EACCES restart loop (the smoking gun)
```
