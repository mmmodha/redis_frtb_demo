# FRTB SBM Redis PoV — HSBC

Sales-vehicle demo proving Redis Enterprise Software (RS) is the right substrate
for HSBC's FRTB-SA market-risk tooling. See the workspace `spec` note for the full
narrative and the 13 Redis Enterprise buying signals each demo moment lands.

## Architecture (high level)

Seven microservices, each fault-isolated, each killable without bringing down the UI:

| Service       | Purpose                                                                      |
|---------------|------------------------------------------------------------------------------|
| `ui`          | Next.js frontend — Connections, Ingest, Pivot, Calc, Observability panels    |
| `api`         | Fastify gateway — proxies UI → Redis, owns the active-target router          |
| `generator`   | Synthetic FRTB sensitivity producer — streams into Redis Streams             |
| `source`      | File/upload ingestion — column-mapping wizard, CSV/JSONL/Parquet readers     |
| `ingest`      | Stream consumer — writes JSON sensitivity docs into the active Redis target  |
| `calc`        | SBM Delta/Vega orchestrator — loads Redis Functions, fans out `FCALL`        |
| `loadgen`     | Concurrent-analyst load generator — drives the scale moments                 |

**There is no Redis container in this compose stack.** Redis Enterprise Software
runs inside HSBC's perimeter (their VPC / on-prem) and is configured at runtime
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

```bash
docker compose up -d
docker compose ps
```

All seven services come up healthy. The UI is on <http://localhost:3000>, the api on
<http://localhost:8080>. On first boot the UI shows
*"No active connection — add a Redis Cloud connection to begin"*.

### Add a Redis target

Open the UI → **Connections** panel → **Add connection** → enter your RS cluster
host, port, TLS / ACL credentials → **Test** → **Set active**. Every backend service
that needs Redis pulls the active target from the api router; nothing is hard-coded.

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

## Testing & TDD

Every production module is written test-first. The root `npm test` runs
`vitest run` across all workspaces; per-package tests live next to the code
they cover (e.g. `services/<svc>/tests/`, `shared/schema/tests/`).

Monorepo-level contract tests live in `tests/monorepo/` and assert:

- `docker-compose.yml` defines all seven services with healthchecks
- No Redis container is started by default (`dev-redis` profile only)
- Root `package.json` declares npm workspaces for `services/*` and `shared/*`
- Each service exposes a `start` script and a Dockerfile

## Redis Enterprise license

The recommended path is the **Redis Enterprise trial / eval license**, valid for
local PoV use. Production deployments at HSBC require a commercial RS subscription
(K8s Operator on GKE/EKS/OpenShift or Ansible roles for VM-based — see the spec's
deployment-paths section).
