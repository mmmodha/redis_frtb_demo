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


## Discovery sets (Wave 7.0.6.13a)

Each HSET is co-pipelined with three SADDs that populate the discovery
layer calc reads via `SMEMBERS`:

* `seen:risk_class` — every risk class that has at least one row.
* `seen:bucket:<rc>` — buckets observed within `<rc>`.
* `seen:sens_type:<rc>:<bkt>` — sens types observed within `(rc, bkt)`.

Key shapes mirror `services/ingest/src/consumer.ts:emitSeenSadds`; both
ingest paths (stream consumer, bulk loader) write the same tag-free
shapes defined in `shared/calc/src/rollup-keys.ts`. Without these sets
`/calc/sbm` discovers no buckets to dispatch over and returns
`data_status:"empty"` even when `sens:*` keys are present.

Per-worker counters `seen_sadds_emitted` / `seen_sadds_failed` (and
their top-level sums on `GET /load/status`) confirm the writer populated
the discovery layer. After a healthy ingest, `seen_sadds_emitted` is
`3 × rows-flushed` and `seen_sadds_failed` is `0`.

### Migration

Any target that received bulk-loader-written rows BEFORE Wave 7.0.6.13a
has rows in `sens:*` but missing entries in the `seen:*` sets, so calc
discovery on that target will return empty. There is no in-place backfill
route by design (operator policy: a FLUSHDB on the affected target is the
only supported recovery — repair-by-scan is intentionally out of scope to
avoid production accidents). Operator steps:

1. Confirm the target is the one to repair (`/admin/active-target` on the api).
2. `redis-cli -h <host> -p <port> FLUSHDB` (or the equivalent for the
   Cloud target).
3. Re-ingest. The first row written populates `seen:risk_class`; calc
   discovery is restored as soon as the first batch flushes.

## Verification SOP

All bulk-loader regression checks MUST run against a FLUSHDB'd clean
target. Stale `seen:*` sets from prior runs will mask discovery-layer
holes — the legacy stream consumer is the canonical writer of those sets,
so a target previously hit by the stream path keeps the discovery layer
populated even if the bulk writer is broken. Operators / CI smokes:

* Before any bulk-loader → calc smoke, run `redis-cli FLUSHDB` against
  the bound target and confirm `DBSIZE == 0`.
* After a fresh bulk ingest, verify `GET /load/status` reports
  `seen_sadds_emitted > 0` and `seen_sadds_failed == 0`.
* Probe `SMEMBERS seen:bucket:GIRR` / `SMEMBERS seen:sens_type:GIRR:<bkt>`
  before running the calc smoke — empty results mean the writer
  regressed.

This guidance applies to local operator scripts only; the bulk-loader
does NOT enforce a FLUSHDB at runtime on `/load/start` (production
accident-class risk).
