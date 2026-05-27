# Wave 5.11 — Live smoke re-run #5 — SUMMARY

**Verdict: ❌ STOPPED at step 4 — bootstrap blocker (new, distinct from Wave 5.9 EACCES).**

Wave 5.10.1 chown fix landed correctly (✅ verified). A new, separate bootstrap
blocker is now exposed: the api image is built without `config/schema/` baked
in, so `frtb-default.yaml` is missing at the path the api looks up
(`/app/config/schema/frtb-default.yaml`). Bootstrap exits via the `schema-missing`
skip path — **no `idx:sens` is created and no Functions library is loaded** —
so steps 5-11 are pointless and were not executed. Stack torn down cleanly.

## What worked (positive evidence)

| Check | Result |
|---|---|
| `.env.local` present | ✅ `envfile_ok` |
| `docker compose config -q` | ✅ `compose_ok` |
| `docker ps` clean pre-up | ✅ empty |
| `scripts/smoke-reset-cluster.sh --yes` | ✅ exit 0, XLEN sensitivities:in = 0, used_memory 12.98M / shard |
| Stale named volume pre-removed | ✅ none existed (first-mount path exercised) |
| `docker compose up -d --wait` | ✅ exit 0, WALLCLOCK_SEC = **52** |
| Healthy services count | **6 / 7** (api, calc, ingest, source, loadgen, ui ✅; generator unhealthy — see note) |
| **Chown gate (3.5):** `ls -ld /data` inside api | ✅ `drwxr-xr-x 2 node node 4096 May 27 14:42 /data` — Wave 5.10.1 fix verified |
| **Chown gate (3.5):** `EACCES\|fatal` grep on api logs | ✅ **empty** — no EACCES |
| Bootstrap line 1 — redis-ready | ✅ `{"service":"api","status":"redis-ready","mode":"cluster"}` |
| `/observability/shards` | ✅ 2 primaries, slotCount 8192 + 8192 = 16384 |
| `/connections` | ✅ contains `demo-cluster` (and `scale-cluster`) — Wave 5.8.5 confirmed |

## What broke (the step-4 stop)

Bootstrap lines 2 and 3 (idx:sens + frtb) **missing**. Instead the api logs:

```
{"service":"api","status":"redis-ready","mode":"cluster"}
{"service":"api","bootstrap":"skipped","reason":"schema-missing","path":"/app/config/schema/frtb-default.yaml"}
{"service":"api","status":"ready","port":8080,"target":"env:REDIS_URL"}
```

Verification inside the api container:

```
$ docker compose exec -T api sh -c 'ls -la /app/config'
ls: /app/config: No such file or directory
```

The file exists in the repo at `config/schema/frtb-default.yaml` (18 KB) but
is never COPYed into the api image.

### Root cause

`services/api/Dockerfile` does not include a `COPY config/schema ./config/schema`
(or equivalent) line. Compare with `services/generator/Dockerfile`, which
explicitly bakes the schema in:

```
# services/generator/Dockerfile
COPY config/schema ./config/schema
```

…with a comment noting *"Schema YAMLs are loaded at runtime via SCHEMA_FILE
(set in docker-compose.yml to /app/config/schema/frtb-default.yaml). Copied
here so the generator runs inside the container without bind-mounting the
repo."*

The api uses the same SCHEMA_FILE default (`services/api/src/index.ts:22`) but
never gets the file copied. `docker-compose.yml` only sets `SCHEMA_FILE` for
the generator service (lines 100-103), so the api falls back to the same
default path, which still doesn't exist in the image.

### Why Wave 5.10.1 didn't catch this

Wave 5.10.1 fixed the EACCES bootstrap blocker by chowning `/data` and softening
seedConnections error handling. With the EACCES gone, bootstrap now reaches
the *next* check (the schema-file read), which silently skips into the
`schema-missing` branch — which is exactly what Wave 5.7 also hit, except
5.10.1 now catches it cleanly with a structured log line.

### Generator container "unhealthy" — not a blocker, side observation

The long-running `generator` compose service (separate from `docker compose run --rm generator`)
started its own 2,000,000-row burst with all 7 risk classes at stack-up and
quickly drove the cluster to **751 MB used per shard ≈ 1.5 GB total**
(visible in `/observability/shards`). The compose healthcheck fails while the
generator is mid-burst (no HTTP server). This matches prior runs — the
generator service is meant to be invoked on-demand in step 7 with explicit
flags. Not Wave 5.11's blocker, but worth a Wave 5.12 sub-task to either:
(a) disable the long-running generator service in compose (rely on `compose run --rm` only), or
(b) make its default a no-op so it doesn't compete with step-7 invocations.

## Steps NOT executed (per stop-on-bootstrap-fail rule)

5 (/observability/shards — *did manually for context, see above*) · 6 (/connections — *did manually*) · 7 (generator targeted run) · 7.5 (per-variant density) · 8 (6-variant calc) · 9 (200-user loadgen) · 10 (live e2e) · 11 (compose down) — *executed*

Without a populated `idx:sens` index, any `/calc/sbm` POST would return 503
("data starvation" or RQE-pipeline missing-index error), regardless of how
many rows the generator pushed into the `sensitivities:in` stream. Continuing
past step 4 would only have generated misleading red numbers.

## AC verdicts (honest)

| AC | Verdict |
|---|---|
| 6 variants <2s wall-clock on (whatever fits) rows | ❌ FALSIFIED — bootstrap skipped, calc not exercised |
| 200-user p99 <500ms over real compute | ❌ FALSIFIED — not executed; would have hit 503 path |

→ Spec remains **YELLOW**. Wave 4.9 (recording) stays blocked.

## Wave 5.12 candidate list

1. **(blocker) services/api/Dockerfile**: add `COPY config/schema ./config/schema` immediately before `USER node` so `/app/config/schema/frtb-default.yaml` is present at runtime. Mirror the generator Dockerfile pattern + carry over the same explanatory comment.
2. **(belt-and-braces) docker-compose.yml**: optionally set `SCHEMA_FILE: ${SCHEMA_FILE:-/app/config/schema/frtb-default.yaml}` on the api service too, so the path stays an explicit contract rather than relying on the in-code default.
3. **(diagnostic-quality)** Consider escalating `{"bootstrap":"skipped","reason":"schema-missing"}` to `level: 40` (warn) or surfacing it via `/healthz` so a future compose-up actually goes unhealthy when bootstrap can't run — currently the api reports `200 OK` on `/healthz` despite an incomplete bootstrap, which is exactly the failure mode Wave 5.7 hit.
4. **(secondary)** Decide what to do with the long-running `generator` compose service that starts its own 2M-row burst at `compose up` and ends up "unhealthy". Either disable it by default or change its CMD to a no-op so step-7's targeted `compose run --rm generator` is the only path that loads data.
5. **(operational)** Once 1-3 land, **re-run Wave 5.11 verbatim as Wave 5.13** (same 11-step plan + the chown gate + a new step-4 schema gate that's already implicit).

## Sanity-vs-oracle sniff

N/A — no real compute happened. (Cluster did reach ~1.5 GB used during the
generator's all-classes burst, which is consistent with the ~700 MB/shard
budget — i.e., infrastructure is sized as expected; the gap is purely the
api image.)

## Artifacts in this folder

- `logs/cluster-reset.log` — successful reset, exit 0
- `logs/compose-up.log` — full `docker compose up -d --wait` output
- `logs/compose-ps.log` — final docker compose ps snapshot
- `logs/data-ownership.log` — `ls -ld /data` (node:node confirmed)
- `logs/api.log` — full api container logs (23 lines; bootstrap-skipped visible)
- `logs/generator-startup.log` — generator's all-classes auto-burst startup log
- `logs/api-config-tree.log` — proof that `/app/config` does not exist in the api image
- `logs/connections.json` — `/connections` response (sanitised; only public host/port for demo-cluster + scale-cluster, no creds)
- `logs/observability-shards.json` — `/observability/shards` response (2 primaries, 8192+8192 slots)
- `logs/compose-down.log` — clean tear-down
