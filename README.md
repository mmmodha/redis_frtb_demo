# FRTB SBM on Redis

FRTB-SA market-risk on Redis — same code, any Redis (OSS Stack / Redis 8 / Cloud / Enterprise).

For the customer demo narrative, follow [`docs/demo-script.md`](docs/demo-script.md).

## What this demo shows

Three Redis capabilities, one workload, one click to swap the substrate underneath them:

- **Data** — synthetic FRTB sensitivities ingested via Redis Streams (XADD → XREADGROUP → HSET into `sens:*` keys).
- **Search** — RediSearch `idx:sens` index over TAG/NUMERIC/TEXT fields for sub-second per-bucket discovery.
- **Compute** — SBM Delta/Vega kernels as Redis Functions (Lua, `FCALL`); one library, fanned out per bucket.

All three live inside one Redis target — switchable at runtime through the UI.

## Architecture

Seven application services. No Redis container; the active target is nominated at runtime.

| Service       | Purpose                                                                                                       |
|---------------|---------------------------------------------------------------------------------------------------------------|
| `ui`          | Next.js frontend — Connections, Ingest, Search, Calc, Observability panels                                    |
| `api`         | Fastify gateway — proxies UI → Redis, owns the active-target router                                           |
| `generator`   | Synthetic FRTB sensitivity producer — streams into Redis Streams                                              |
| `source`      | File/upload ingestion — column-mapping wizard, CSV/JSONL/Parquet readers                                      |
| `ingest`      | Stream consumer — writes HASH sensitivity docs (default `STORAGE_FORMAT=hash-sidetable`) into the active target |
| `calc`        | SBM Delta/Vega orchestrator — loads Redis Functions, fans out `FCALL`                                         |
| `loadgen`     | Concurrent-analyst load generator — drives the scale moments                                                  |

```text
                                       ┌────────────────────────┐
   browser ──► :3000 (ui) ──► :8080 (api) ──► │  Active Redis target  ☁  │
                                    ▲          │  (OSS / Stack / Cloud  │
                                    │          │   / Enterprise)        │
   source ────────────────┐         │          └────────────────────────┘
   ingest ────────────────┼─────────┘            ▲          ▲          ▲
   calc   ────────────────┤                      │          │          │
   loadgen ───────────────┘     (all reach Redis through api's active-target router)
```

There is no Redis in this compose stack — the Connections panel nominates the active target at runtime.

## Prerequisites & supported Redis flavours

- Node.js ≥ 20
- Docker Engine ≥ 24 + Compose v2
- A reachable Redis with RediSearch, RedisJSON, and Redis Functions:
  - **Redis 8.x OSS** — Search and JSON are now in core
  - **Redis Stack** — `redis-stack-server`, OSS plus bundled modules
  - **Redis Cloud** — Essentials or Pro
  - **Redis Enterprise Software** — the bank's perimeter deployment

Hard requirement: Redis **7.0+** (Functions are core from 7.0 onward) with the Search and JSON modules loaded.

## Quick start

`.env.local` is gitignored and auto-created with generated secrets on first run; you do not need to edit anything by hand.

### Docker

```bash
docker compose up -d --wait
open http://localhost:3000           # → Connections panel → Add → Test → Set active
```

### Local (no Docker)

```bash
scripts/run-local.sh start
open http://localhost:3000           # same Connections flow
```

All seven services come up healthy. The UI serves on :3000, the api on :8080. Until you nominate an active Redis in the Connections panel, the UI shows *"No active connection"*.

## Connecting Redis (cold vs warm)

The api never picks its own Redis. It waits for the UI Connections panel (or a pre-seeded `REDIS_URL`) to nominate an **active target**, then auto-bootstraps the FRTB index and Functions library against that target. Two flows; the api detects which one it's in.

### Cold target (first boot)

A fresh Redis instance with no `idx:sens:v*` index and no `frtb` library loaded.

When you click **Set active**:
1. The active-target change kicks off bootstrap in the background.
2. Bootstrap issues **one** `FT.CREATE idx:sens:v{hash}` plus **one** `FUNCTION LOAD` for the `frtb` library, then persists the schema hash under `bootstrap:schema-hash:<target_label>`.
3. `/readyz` flips to 200 in roughly **2–3 s**.
4. `/calc/sbm` returns `503 no-data-or-index` until you ingest — the index exists but is empty.

### Warm target (restart)

Same Redis after a previous bootstrap has settled — typical of `docker compose restart api` or re-activating an existing profile.

What happens:
1. Bootstrap runs, finds the persisted schema hash matches and the versioned index is present on every master.
2. It **short-circuits** — zero `FT.CREATE`, zero `FT.DROPINDEX`, zero `FUNCTION LOAD` writes.
3. `/readyz` flips to 200 in roughly **1–2 s**.
4. `/calc/sbm` is immediately usable; the data, index, and library all survive the api restart because they live inside Redis.

### Verify

```bash
curl -fsS http://localhost:8080/readyz
curl -fsS http://localhost:8080/redis/active-target/bootstrap-status
```

`phase` is one of `idle | running | ready | partial | failed`. `ready` is the only value that lets calc/search routes serve traffic.

## Cross-cluster switching

The headline. One click moves the workload from one Redis target to another with no code change.

- The api owns an **active-target router**. Changing the active connection — in the UI or via `POST /redis/active-target` — pushes the new target to ingest, source, and loadgen over the internal credential endpoint.
- Bootstrap is a phase machine: `idle → running → ready` (or `partial` / `failed` on error), surfaced at `/redis/active-target/bootstrap-status` and the same UI badge.
- Switching is observable: the Connections panel shows per-service progress as each downstream picks up the new target.
- Same code path against every flavour listed above — no per-flavour conditionals, no recompile.
- Ingest's in-flight stream batches drain cleanly before the switch commits (no data loss; bounded 30 s drain window).

## Synthetic data: `generator`

`generator` is a one-shot CLI that streams synthetic FRTB sensitivities into the `sensitivities:in` stream and exits — it is **not** part of `start`. Invoke it explicitly:

```bash
scripts/run-local.sh start generator                    # default: 2,000,000 rows
scripts/run-local.sh start generator -- --rows 1000     # small/dev run
scripts/run-local.sh logs generator -f                  # follow progress
```

Anything after `--` is forwarded to the generator CLI (`--rows`, `--rate`, `--seed`, `--stream`, `--classes`, `--sensitivity-types`). The default run emits all three sensitivity types: Delta, Vega, and Curvature.

## Operations: `scripts/run-local.sh`

```text
start [svc]      Start all services (or one named service)
stop [svc]       Stop all (or one)
restart [svc]    Stop then start
status           Per-service state table + health
logs <svc> [-f]  Tail .run/logs/<svc>.log
reconcile [svc]  Recover from hung/orphan/foreign listener state
doctor           Diagnostics
```

`status` reports one of:

- `running:<pid>` — pidfile alive, port bound, health OK (green)
- `hung:<pid>` — pidfile alive but port not bound (yellow)
- `orphan:<pid>` — pidfile dead but port still held by another pid (red)
- `foreign:<pid>` — no pidfile but port held (red)
- `dead:<pid>` — stale pidfile only, no process, no listener (red)
- `stopped` — clean state

Default behaviour on `stop` and `reconcile` is **SIGTERM-only with diagnostics**. `--force` is an opt-in SIGKILL escape hatch for hung/orphan/foreign listeners that ignore SIGTERM — use it only after the diagnostic output has told you which pid is holding the port.

`restart api` (and `restart <svc>` in general) broadly cleans up any stale processes that survived a previous run, so a normal restart is enough to fix most orphans without escalating to `--force`.

Runtime state — PIDs, logs, env snapshot — lives under `./.run/`. Reset cleanly with `scripts/run-local.sh stop && rm -rf .run/ .env.local`.

## Storage formats

```text
hash-sidetable     (default) HASH doc + per-tenor side table; idx:sens covers it
hash-encoded       HASH doc with packed per-tenor fields; idx:sens covers it
json               JSON.SET only; customer-owned index required (escape hatch)
json-shadow-hash   JSON primary + HASH shadow for idx:sens coverage
```

Set via the `STORAGE_FORMAT` env on the ingest service. The default works for every demo path.

## Environment overrides

`.env.local` is optional, gitignored, and auto-generated on first run with safe defaults. Four knobs cover almost every real override:

- `REDIS_URL` — pre-seed an active target instead of using the Connections panel
- `CONN_STORE_KEY` — 32-byte hex; encrypts the Connections store
- `INTERNAL_API_TOKEN` — internal bearer between services
- `STORAGE_FORMAT` — see [Storage formats](#storage-formats)

See [`.env.example`](.env.example) for the full annotated list, including per-service ports, TLS, pool sizing, and calc-path selectors.

## Single-port deploy

Both deployment paths only need **port 3000** exposed externally. The UI server reverse-proxies every `/api/*` request to the api over loopback, so the browser never has to know the api's host or port.

```text
browser ──► :3000 (UI) ──► 127.0.0.1:8080 (api)  ◄── same-origin /api/*
                                  │
                                  └── never exposed beyond the host
```

- **Docker compose** — only the `ui` service needs a host-port binding. The `8080:8080` mapping on api is a convenience for local debugging; remove it (or block at the firewall) on a deploy VM. The UI reaches api via the compose-internal DNS name `api:8080`.
- **Bare-metal (`scripts/run-local.sh`)** — services bind on `127.0.0.1` by default. Only `:3000` needs to be reachable from your browser.

### Quick validation

```bash
curl -fsS http://localhost:3000/healthz       # UI's own healthz
curl -fsS http://localhost:3000/api/healthz   # api via the UI proxy — must NOT return HTML
```

If the second call returns HTML, the bundle was built against an older `VITE_API_BASE` or the proxy block is missing — rebuild the UI image or re-run `scripts/run-local.sh doctor`.

### Split-host escape hatches

If you ever need to point the UI at an api on a different host or port, the relevant knobs are `VITE_API_BASE` (UI build-time), `UI_API_PROXY_HOST`, and `UI_API_PROXY_PORT` (UI runtime). All three are documented in `.env.example`.

## Testing

`npm test` runs every workspace's vitest suite. Per-package tests live next to the code they cover (`services/<svc>/tests/`, `shared/schema/tests/`).

Monorepo contract tests in [`tests/monorepo/`](tests/monorepo/) assert that `docker-compose.yml` defines every expected service with healthchecks, no Redis container ships by default, and root `package.json` declares the right workspaces.

A gated live anchor lives at [`services/api/tests/calc-live-200k.test.ts`](services/api/tests/calc-live-200k.test.ts); it pins `/calc/sbm` charge and per-bucket `K_b` numbers against a fixed balanced-thirds 200k corpus when run against a populated target.

## Troubleshooting

**1. Missing modules at bootstrap.** `/readyz` stays 503 with `bootstrap-failed`. The target Redis is missing Search or JSON. Fix: switch to Redis Stack, Redis 8 OSS, Redis Cloud, or Redis Enterprise with both modules loaded.

**2. `bootstrap-status` stuck at `running` > 30 s.** Usually a slow `FT.DROPINDEX` against a populated legacy index on the target. The bootstrap timeout is 90 s and the operation is idempotent — wait it out. If it still fails, capture api logs and re-activate the same profile; bootstrap is safe to re-fire.

**3. `status` shows `orphan:<pid>` or `foreign:<pid>`.** A previous run left a listener on the port. Run `scripts/run-local.sh reconcile <svc>` first; if the holder ignores SIGTERM, escalate with `scripts/run-local.sh reconcile <svc> --force`. The status table names the pid so you always know what `--force` will kill.

## Further reading

- [`docs/demo-script.md`](docs/demo-script.md) — customer demo narrative, step by step
- [`docs/asset-pack/`](docs/asset-pack/) — solution-architect materials (decks, recordings, runbooks)
- Redis Enterprise eval / trial license is fine for PoV; production at the bank requires a commercial RS subscription
