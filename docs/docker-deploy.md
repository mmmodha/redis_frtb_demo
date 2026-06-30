# Docker deployment (default)

Docker Compose is the **primary** deployment path for this PoV. Bare-metal
(`scripts/run-local.sh`) remains available for laptop debugging only.

## Quick start

```bash
# 1. Optional: point at Redis Enterprise (or use dev-redis profile — see below)
cp .env.example .env.local   # or let scripts/docker-up.sh create a minimal file

# 2. Start the full stack (4 bulk-loader replicas by default)
scripts/docker-up.sh

# 3. Open the UI and nominate Redis
open http://localhost:3000    # → Connections → Test → Set active

# 4. Bulk ingest from the Ingest panel (preset → Start)
```

Equivalent raw Compose:

```bash
docker compose up -d --wait --scale bulk-loader=4
```

## Profiles

| Command | Use case |
|---------|----------|
| `scripts/docker-up.sh` | Default — 4 bulk-loader replicas, Wave 7 env |
| `scripts/docker-up.sh --dev` | Laptop — 1 bulk-loader replica |
| `scripts/docker-up.sh --scale 400m` | 400M-row ingest — 8 replicas, pool 16, batch 2000 |
| `scripts/docker-up.sh --build` | Force image rebuild on `up` |

## Services (8 containers)

| Service | Role |
|---------|------|
| `ui` | Browser entry (:3000), proxies `/api/*` |
| `api` | Gateway, bootstrap, bulk-ingest orchestrator, calc |
| `bulk-loader` | Pooled HSET writer (scale horizontally) |
| `ingest` | Live-tail stream consumer only |
| `generator` | Idle under `up`; CLI via `docker compose run --rm generator --rows N` |
| `source`, `calc`, `loadgen` | Upload, calc worker, load generator |

Redis is **not** included — configure via the UI **Connections** panel after
boot. Optionally pre-seed `REDIS_URL` in `.env.local` for CI/demo shortcuts.

### Redis on your laptop (outside Compose)

When the app runs in Docker, **`localhost` inside a container means that
container**, not your Mac. If Redis is listening on the host at port `12000`
(or any port), point connections at the host gateway:

| Where you configure | Host | Port |
|---------------------|------|------|
| **Connections** panel (recommended) | `host.docker.internal` | `12000` |
| **`.env.local` pre-seed** | see below | |

```bash
# Optional pre-seed (password/TLS as needed):
echo 'REDIS_URL=redis://:YOUR_PASSWORD@host.docker.internal:12000' >> .env.local
docker compose up -d --build api
```

Then open **Connections → Test → Set active**. Use `host.docker.internal`,
**not** `localhost`, in the profile host field.

Redis must accept TCP from Docker (default `bind 127.0.0.1` on the host is
usually fine with Docker Desktop because `host.docker.internal` routes to the
host loopback). If Test fails with *connection refused*, check that Redis is
listening on `12000` (`redis-cli -p 12000 ping` from your laptop).

### Local Redis (no Cloud account)

```bash
docker compose --profile dev-redis up -d --wait redis
# REDIS_URL=redis://redis:6379 won't work from host — use localhost:6379 in .env.local
echo 'REDIS_URL=redis://host.docker.internal:6379' >> .env.local
scripts/docker-up.sh --dev
```

## Wave 7 defaults (Docker = run-local)

These are set in `docker-compose.yml` and match `scripts/run-local.sh`:

| Variable | Default | Why |
|----------|---------|-----|
| `CALC_LAZY_MATH` | `1` | Weight on read — slim docs, faster writes |
| `ENABLE_SLIM_SENS_INDEX` | `1` | Parallel `idx:sens:slim` for bulk-loaded rows |
| `LIVE_TAIL_MODE` | `true` | Stream ingest writes `sens:*` only |
| `BULK_LOADER_POOL_SIZE` | `16` | Sockets per bulk-loader container |
| `BULK_LOADER_BATCH_SIZE` | `2000` | Rows per HTTP batch |
| `RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC` | `8` | Parallel FT.AGGREGATE / calc fan-out |

Override any of these in `.env.local`.

---

## 400M-row ingest playbook

Target: **400M sensitivities in under ~7 hours** on Redis Enterprise with
`proxy_policy=all-master-shards`.

### 1. Size the VM + Compose scale

```bash
# Example: 32 vCPU / 64 GB VM, 8-shard cluster
export SCALE_BULK_LOADER=8
export BULK_LOADER_POOL_SIZE=16      # 8 × 16 = 128 Redis connections
export BULK_LOADER_BATCH_SIZE=2000
scripts/docker-up.sh --scale 400m --build
```

Rule of thumb: **total connections ≈ replicas × pool_size ≥ 2 × shard_count**,
capped by `maxclients` minus headroom.

### 2. Start ingest from the UI

- Use a large preset (or custom row count = 400_000_000)
- Keep **generator workers at 4–8** (Advanced) — higher values hurt throughput
- Progress survives page refresh (BulkIngestRunContext)

### 3. Post-load finalisation (required for fast calc)

Bulk-loaded rows use lazy math. **Calc is dramatically faster** after rollup
materialisation:

```bash
node --env-file=.env.local scripts/finalise-rollups.mjs
node --env-file=.env.local scripts/finalise-seen-sets.mjs
```

Without rollups, `/calc/sbm` falls back to per-bucket `FT.AGGREGATE` over
400M docs — correct but slow.

### 4. Verify shard balance

```bash
REDIS_URL='…' node --env-file=.env.local scripts/shard-balance-report.mjs
```

Expect per-shard doc counts within ±5% when using tag-free ULID keys.

---

## Calc optimisations at 400M scale

| Optimisation | Status | Impact |
|--------------|--------|--------|
| **Post-load rollups** (`finalise-rollups.mjs`) | Script ready; run after ingest | **Highest** — HGETALL per bucket vs scanning millions |
| **Lazy math + slim index** | On by default in Docker | Smaller docs/index; calc weights at query time |
| **Calc response cache** | Built-in (~short TTL) | Repeat identical queries are instant |
| **Parallel `/calc/sbm/total`** | Built-in (`Promise.all` per cell) | 27 cells overlap Redis round-trips |
| **Larger heavy-calc pool** | `RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC=8+` | More concurrent bucket aggregations |
| **Bucket subset queries** | UI/API `bucket_subset` param | Skip irrelevant buckets |
| **Auto Tiering (Enterprise)** | Operator-side | RAM for hot set, NVMe for tail — cost, not latency |

### Not yet automated (Wave 7 backlog)

See **[optimization-roadmap.md](./optimization-roadmap.md)** for the full phased plan (demo gate → performance → cleanup).

- **7.0.3.A** — trigger rollup finalisation automatically when bulk ingest completes
- **7.0.5.C** — gated 450M validation run on production cluster
- **7.0.4.B** — per-shard observability panel in UI

### Calc path selection (api env)

```
rollup (HGETALL)  →  ft_aggregate (FT.AGGREGATE on slim index)  →  fcall_lua (legacy)
```

With lazy math, run post-load finalisation so calc uses the rollup (HGETALL) path:
After finalisation, `CALC_ROLLUP_PATH=1` (default) serves charges via rollup readout.

### Demo day checklist (400M + 30–40s calc)

1. **Cluster** — Redis Enterprise with `proxy_policy=all-master-shards`; size for ~800 GB row data + indexes.
2. **Launch stack** — `scripts/docker-up.sh --scale 400m --build`
3. **Ingest** — UI preset **400M** (or custom `400_000_000`), workers **4–8**
4. **After ingest completes** (mandatory before calc demo):
   ```bash
   node --env-file=.env.local scripts/finalise-rollups.mjs
   node --env-file=.env.local scripts/finalise-seen-sets.mjs
   ```
5. **Verify** — `GET /admin/calc-coverage` shows rollups present; run `/calc/sbm/total` once (cold), then repeat (cache hit <1s)
6. **Env tuning** (api):
   - `POOL_COMMAND_TIMEOUT_HEAVY_CALC_MS=180000` (compose default)
   - `RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC=8`
   - `CALC_CACHE_TTL_MS=300000` (optional — 5 min cache for demo repeats)

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `compose up --wait` fails on bulk-loader (pre-7.0.8) | Upgrade — bulk-loader `/healthz` is liveness-only while awaiting UI target |
| UI shows "No active cluster" after boot | Expected — open Connections → Add → Test → Set active |
| UI ingest 502 / bulk-load-network-retry | Confirm `BULK_LOADER_URL=http://bulk-loader:8086` on api (compose sets this) |
| Calc 503 / no slim index | Ensure `ENABLE_SLIM_SENS_INDEX=1` on api; re-activate Redis target |
| Calc slow after 400M load | Run `finalise-rollups.mjs` |
| Bulk-loader 503 / throttled | Reduce UI workers; check `recent_429_count` on ingest panel |
| `compose up` unhealthy generator | Expected fixed in 7.0.8 — entrypoint sleeps idle |
