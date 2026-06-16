# FRTB SBM Redis PoV

Sales-vehicle demo proving Redis Enterprise Software (RS) is the right substrate
for a Tier-1 bank's FRTB-SA market-risk tooling. See the workspace `spec` note for the full
narrative and the 13 Redis Enterprise business-value moments each demo step lands.

## Architecture (high level)

Seven microservices, each fault-isolated, each killable without bringing down the UI:

| Service       | Purpose                                                                      |
|---------------|------------------------------------------------------------------------------|
| `ui`          | Next.js frontend — Connections, Ingest, Search, Calc, Observability panels   |
| `api`         | Fastify gateway — proxies UI → Redis, owns the active-target router          |
| `generator`   | Synthetic FRTB sensitivity producer — streams into Redis Streams             |
| `source`      | File/upload ingestion — column-mapping wizard, CSV/JSONL/Parquet readers     |
| `ingest`      | Stream consumer — writes JSON sensitivity docs into the active Redis target  |
| `calc`        | SBM Delta/Vega orchestrator — loads Redis Functions, fans out `FCALL`        |
| `loadgen`     | Concurrent-analyst load generator — drives the scale moments                 |

**There is no Redis container in this compose stack.** Redis Enterprise Software
runs inside the bank's perimeter (their VPC / on-prem) and is configured at runtime
through the UI Connections panel. The Solutions Architect points the app at two
RS clusters: `demo-cluster` (smaller, headline demo) and `scale-cluster` (larger,
Auto Tiering, scale pivot moment).

## Repo layout

```
.
├── docker-compose.yml         7 application services, no Redis
├── package.json               npm workspaces root
├── config/schema/             hot-swappable schema YAML (see schema task)
├── data/                      bind volume: connections.enc.json, sources.json, uploads/
├── services/
│   ├── ui/         api/         generator/     source/
│   ├── ingest/     calc/        loadgen/
├── shared/
│   └── schema/                @frtb/schema — shared TS types generated from YAML
└── tests/
    └── monorepo/              layout + compose contract tests
```

## Getting started

### Prerequisites

- Node.js ≥ 20 (the repo is tested on 25.x)
- Docker Engine ≥ 24 with the Compose v2 plugin
- A reachable Redis Enterprise Software cluster with the **ReJSON**, **RediSearch**,
  and **RedisGears (Functions)** modules. Two options:
  - Provision an RS cluster (trial license is fine for the demo).
  - For local development only: `docker compose --profile dev-redis up redis`
    starts a single-node `redis/redis-stack-server` on `localhost:6379`.

### Boot the application stack

> For deploy-VM topology and single-port firewall guidance see [Single-port deploy (port 3000 only)](#single-port-deploy-port-3000-only).

A fresh clone needs no environment editing. Bring the stack up and configure
Redis through the UI:

```bash
docker compose up -d --wait
# then open http://localhost:3000 → Connections → Add connection
```

All seven services come up healthy. The UI is on <http://localhost:3000>, the api on
<http://localhost:8080>. On first boot the UI shows
*"No active connection — add a Redis Cloud connection to begin"*; open the
**Connections** panel, enter your RS cluster host / port / TLS / ACL credentials,
**Test**, then **Set active**. Every backend service that needs Redis pulls the
active target from the api router; nothing is hard-coded.

`.env.local` is gitignored and optional — `scripts/run-local.sh` auto-creates a
minimal one with generated secrets on first run. See
**Advanced: environment overrides** below if you need custom ports, custom
secrets, or want to pre-seed `REDIS_URL`.

### API health endpoints (Wave 5.97D.1)

The `api` service exposes two k8s-style health probes:

- `GET /healthz` → **liveness**. Always 200 once the api process is accepting
  traffic. Body `{"service":"api","status":"alive"}`. Used by the compose
  healthcheck, `scripts/run-local.sh`, and any orchestrator that needs to
  know "is the process up?"
- `GET /readyz` → **readiness**. 503 with `{"status":"bootstrap-failed", ...}`
  until an active Redis connection is configured (via the UI Connections
  panel or `REDIS_URL`) AND the FRTB library bootstrap resolves. 200 with
  `{"service":"api","status":"ok","bootstrap":"ready"}` once ready. Used by
  callers that need to know "is the api ready to serve Redis-backed routes?"

Splitting the two lets `docker compose up -d --wait` pass on a fresh clone
without any environment editing — process-alive is enough for compose, and
operators wire Redis afterwards through the UI.

### Fault-isolation smoke tests

```bash
docker compose stop ingest    # other services stay healthy
docker compose start ingest
```

### Local development without Docker

```bash
npm install
npm test            # runs the monorepo + per-package vitest suites
npm run -w @frtb/ui start    # boot a single service stub
```

## Local-developer launcher (no Docker)

```bash
scripts/run-local.sh start              # boot the 6 long-running services
scripts/run-local.sh status             # one-line-per-service table + one-shot tool state
scripts/run-local.sh logs api -f        # tail a service log
scripts/run-local.sh doctor             # diagnostics
scripts/run-local.sh stop               # stop all (services + any running one-shot tools)
```

`start` needs no prior setup on a fresh clone: it auto-creates `.env.local`
with generated `CONN_STORE_KEY` + `INTERNAL_API_TOKEN` secrets (no
`REDIS_URL`, since the UI Connections panel is the primary configuration path)
and then boots the six services. Runtime state (PIDs, logs, env snapshot)
lives under `./.run/`. Runs as the invoking user; no sudo, no systemd, no
`/var/lib` paths. To reset cleanly:
`scripts/run-local.sh stop && rm -rf .run/ .env.local`.

### Single-port deploy (port 3000 only)

After Wave 6.05 both deployment paths only need **port 3000** exposed
externally. The UI server (node in bare-metal, nginx in Docker compose)
reverse-proxies every `/api/*` request to the api service over loopback,
so the browser never has to know the api's host or port.

```text
browser ──► :3000 (UI) ──► 127.0.0.1:8080 (api)  ◄── same-origin /api/*
                                  │
                                  └── never exposed beyond the host
```

Concretely:

- **Docker compose** — only the `ui` service binds a host port. The other
  port mappings in `docker-compose.yml` (`8080:8080` for api,
  `6379:6379` for redis) are convenience exposures for debugging on a
  developer laptop. On a deploy VM you can remove them or block them at
  the firewall; the UI still reaches api via the compose-internal DNS name
  `api:8080`.
- **Bare-metal (`scripts/run-local.sh`)** — services still bind on their
  individual ports on `127.0.0.1` by default. Only `:3000` needs to be
  reachable from your browser; everything else stays on loopback.

#### Quick validation

```bash
# UI's own healthz (served locally by the UI server, not proxied):
curl -fsS http://localhost:3000/healthz
# → {"service":"ui","status":"ok"}

# api's healthz reached through the UI proxy (path /api/healthz is stripped
# to /healthz upstream):
curl -fsS http://localhost:3000/api/healthz
# → {"service":"api",...}   (NOT the UI shell HTML)
```

If the second call returns HTML, the bundle was built against an older
`VITE_API_BASE` or the proxy block in `nginx.conf` / `src/index.mjs` is
missing — rebuild the UI image (`docker compose build ui`) or re-run
`scripts/run-local.sh doctor` for guidance.

#### Remote VM deploy

The browser only ever needs to reach port 3000. With a host firewall
(UFW / cloud security group):

```bash
# Allow inbound 3000 only; everything else stays on loopback.
ufw allow 3000/tcp
```

No `VITE_API_BASE` override is needed — the bundle's default of `/api` is
correct for any same-origin deploy.

#### Split-host or custom upstream (escape hatches)

If you ever need to point the UI at an api running on a different host or
port (multi-VM, sidecar, blue/green), use these overrides:

| Knob | Path | Default | Use when |
|---|---|---|---|
| `VITE_API_BASE` | UI build-time env | `/api` | The api lives at a different origin (e.g. `https://api.example.com`). Baked into the JS bundle at `npm run build` time. |
| `UI_API_PROXY_HOST` | UI runtime env (bare-metal) | `127.0.0.1` | The api isn't on the same machine as the UI server. |
| `UI_API_PROXY_PORT` | UI runtime env (bare-metal) | `8080` (falls back to `API_PORT`) | The api binds a non-default port. |

In Docker compose the upstream is hardcoded to `api:8080` (the compose
service hostname); change `services/ui/nginx.conf` if you genuinely need a
different upstream. `VITE_API_BASE` is still respected.

#### Streaming, uploads, SSE

The proxy is configured to never buffer:

- **CSV / JSON uploads** (`POST /api/sources/upload`) stream the request
  body straight through with no `maxBodyLength` cap on either side.
- **Server-Sent Events** (`/api/inflight/stream`, `/api/loadgen/metrics`,
  generator progress) keep the connection open for 24h with response
  buffering off, so the browser sees each chunk as it lands.
- Headers are forwarded verbatim, including `content-type` with multipart
  boundaries — large CSV drops are byte-exact end-to-end.

### Synthetic data: the `generator` one-shot tool

`generator` is a one-shot CLI that streams synthetic FRTB sensitivities into
the `sensitivities:in` Redis Stream and exits — it is **not** part of the
default `start`. Invoke it explicitly only when you want to populate data:

```bash
scripts/run-local.sh start generator                    # default: 2,000,000 rows
scripts/run-local.sh start generator -- --rows 1000     # small/dev run
scripts/run-local.sh logs generator -f                  # follow progress
```

Anything after `--` is forwarded to `tsx services/generator/src/cli.ts`
(e.g. `--rows`, `--rate`, `--seed`, `--stream`, `--sensitivity-types Delta,Vega,Curvature`
— default emits all three types).

### Canonical 200k baseline (Wave 5.84)

The gated live test [`services/api/tests/calc-live-200k.test.ts`](services/api/tests/calc-live-200k.test.ts)
pins `/calc/sbm` charge + per-bucket K_b anchors against a fixed balanced-thirds
200k corpus. Reproduce it with:

```bash
docker compose run --rm generator --rows 200000 --classes GIRR,EQUITY,FX
```

Class distribution is balanced thirds — **GIRR 66667 / EQUITY 66667 / FX 66666**
(generator splits `--rows` evenly across the requested `--classes` list, then
splits each class evenly across Delta / Vega / Curvature). The captured
charge + bucket sweeps for the current pins live in
[`docs/recordings/wave-5.84-corpus/`](docs/recordings/wave-5.84-corpus/)
(captured 2026-06-08); these replaced the legacy skewed ~60/30/10 anchors
under `docs/recordings/wave-5.83K/`. Re-anchor against new corpus only when
the generator's class / leg split itself changes — anchors are corpus-derived,
not hand-picked.

## Advanced: environment overrides

`.env.local` is optional. Use it when you need to:

- **Pre-seed a Redis target** — set `REDIS_URL=...` and the api auto-seeds a
  `live-standalone` / `live-cluster` Connection profile in the UI on boot.
  Without it, add the connection through the UI Connections panel.
- **Rotate secrets by hand** — `CONN_STORE_KEY` (32-byte hex; encrypts the
  Connections store) and `INTERNAL_API_TOKEN` (16-byte hex; api↔source/loadgen
  internal bearer). `scripts/run-local.sh start` generates these on first
  run; override here for CI / shared dev boxes. `doctor` warns if
  `CONN_STORE_KEY` is still the literal `dev-only-change-in-prod` default.
- **Remap service ports / hosts** — `API_PORT`, `UI_PORT`, etc. (full list in
  the Wave 5.79 block of `.env.example`).
- **Tweak Redis client behaviour** — `REDIS_TLS`, `REDIS_CLUSTER`,
  `REDIS_READY_TIMEOUT_MS`, `ALLOWED_ORIGINS`.

See `.env.example` for the full annotated list. Copy individual entries into
`.env.local` only as needed; missing values fall back to the documented
defaults.

## Testing & TDD

Every production module is written test-first. The root `npm test` runs
`vitest run` across all workspaces; per-package tests live next to the code
they cover (e.g. `services/<svc>/tests/`, `shared/schema/tests/`).

Monorepo-level contract tests live in `tests/monorepo/` and assert:

- `docker-compose.yml` defines all seven services with healthchecks
- No Redis container is started by default (`dev-redis` profile only)
- Root `package.json` declares npm workspaces for `services/*` and `shared/*`
- Each service exposes a `start` script and a Dockerfile

## Troubleshooting

### "Rebuild indexes" fails with `SEARCH_INDEX_NOT_FOUND Index not found: idx:sens`

On a fresh Redis 8.x cluster, bootstrap's `FT.DROPINDEX idx:sens` call rejects
with `SEARCH_INDEX_NOT_FOUND Index not found: idx:sens` because the index
hasn't been created yet — older builds expected the legacy RediSearch
`"Unknown Index name"` phrasing and surfaced the rejection instead of treating
it as a no-op. Wave 6.09 relaxes the matcher so current builds tolerate this
automatically; the manual recovery below works on any version.

Manual recovery from Redis Workbench or `redis-cli`:

```
FT.CREATE idx:sens ON JSON PREFIX 1 sens: SCHEMA $.book AS book TAG
```

Then click **Rebuild indexes** in the UI — bootstrap will now drop the stub
and recreate the proper schema-aware index.

Prefer a CLI? Run `node tools/rqe-index-cli/src/bin.mjs ensure` against the
target Redis — it performs the same idempotent create without the Workbench
round-trip.

## Redis Enterprise license

The recommended path is the **Redis Enterprise trial / eval license**, valid for
local PoV use. Production deployments at the bank require a commercial RS subscription
(K8s Operator on GKE/EKS/OpenShift or Ansible roles for VM-based — see the spec's
deployment-paths section).
