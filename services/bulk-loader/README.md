# bulk-loader

Fast-path Redis writer for FRTB sensitivity rows. Accepts `POST /load/rows`
from the api (UI "Start ingest") and the generator CLI (`BULK_LOAD_TARGET`),
batches rows, then fans HSET + HINCRBYFLOAT + SADD pipelines across a fixed
pool of ioredis sockets. Single-node and proxy-fronted Enterprise clusters
are both supported; cluster-mode ioredis is not used — the proxy spreads
connections across masters via `proxy_policy=all-master-shards`.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `BULK_LOADER_PORT` | `8086` | HTTP listen port. |
| `BULK_LOADER_POOL_SIZE` | `32` | **See "Pool sizing" below.** Number of parallel ioredis sockets the dispatcher rotates HSET pipelines across. |
| `BULK_LOADER_BATCH_SIZE` | `1000` | Rows per dispatched batch (per socket). |
| `BULK_LOADER_IDLE_FLUSH_MS` | `50` | Maximum time a partial batch sits before flushing. |
| `BULK_LOADER_HIGH_WATER` | `5 × batch × pool` | Producer backpressure threshold; `/load/rows` 503s when exceeded. |
| `BULK_LOADER_CHECKPOINT_INTERVAL_MS` | (see `checkpoint.ts`) | How often progress is persisted to Redis. |

## Pool sizing (`BULK_LOADER_POOL_SIZE`)

The dispatcher's throughput is bounded by `pool_size × per-socket-rps`. On
a single-shard Redis the default of 32 saturates a single master at
~100k HSET/sec. On a multi-shard cluster the pool size **must be ≥ the
master-shard count** so each shard has at least one dedicated socket:

| Topology | Recommended `BULK_LOADER_POOL_SIZE` |
| --- | --- |
| Single-node Redis (laptop / `scripts/run-local.sh`) | `32` (default) |
| 3-shard Enterprise cluster (proxy) | `32` — proxy fans across masters |
| 8-shard cluster | `32`–`64` |
| 16+ shards | `pool_size = 2 × shards` (≤ `maxclients - headroom`) |

The current pool size is surfaced via the api's `GET /admin/host-info`
endpoint (Wave 7.0.6.15) — the UI's IngestPanel reads it to flag obviously
undersized pools next to the worker slider.

### Tuning checklist

1. Boot the bulk-loader: `curl http://localhost:8086/load/status` → confirm
   `pool_size` matches the env var and `connected` matches `pool_size`.
2. Run a 100k-row ingest from the UI. Check `/load/status` again:
   `rows_total` should grow, `inflight` should stay below `high_water`.
3. If RPS plateaus well below the per-shard cap, scale `BULK_LOADER_POOL_SIZE`
   upward in powers of 2 and re-test. Cap at `(maxclients - 10) / shards`.

## Multi-worker producers (Wave 7.0.6.15)

The api's `/ingest/bulk/start` accepts a `workers` parameter that fans row
synthesis across `worker_threads`. Each worker opens its own HTTP keep-alive
client to the bulk-loader (`httpInFlight` defaults to `concurrency / workers`),
so the aggregate POST rate is unchanged but row generation is no longer
single-threaded. The bulk-loader sees the same `/load/rows` body shape; only
the producer-side parallelism changes.
