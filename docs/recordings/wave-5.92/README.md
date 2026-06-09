# Wave 5.92 — Multi-stream benchmark + readiness write-up

Status: **deferred — no multi-shard target reachable in this workspace** (matches
the Wave 5.84D DoD #4 fallback). This README pins the methodology, the
reproducer command matrix, the missing prerequisites, and the readiness
statement so the next operator on a real multi-shard cluster can land the
numbers without rediscovering the shape of the bench.

## Target reachable in this workspace

The only Redis reachable from this workspace is a **single-shard Redis Cloud
DB** (`REDIS_CLUSTER=FALSE`, `mode=standalone`, `shards=1`) — the same target
the Wave 5.84D `S` row was pinned against. Without a 2+ master cluster the
`--stream-shards 2/4/8` cells of the matrix collapse to "one Redis node with N
stream keys" and cannot validate inter-shard scaling.

A local `docker compose --profile dev-redis` brings up a single-node
`redis/redis-stack-server` only; no `redis-cluster` profile exists yet.
Standing one up (3-master Bitnami / OSS cluster init via `redis-cli --cluster
create`) is left to a follow-up wave so it can be implemented and verified
end-to-end with the consumer-orchestration harness extension below.

## Two gaps that must close before the matrix can land

1. **Multi-shard target.** Either a local `redis-cluster` compose profile
   (`CLUSTER_SHARDS=4`) or a reachable Redis Enterprise dev cluster /
   ElastiCache cluster mode endpoint. The harness reads `REDIS_URL` /
   `REDIS_CLUSTER` and works against either.
2. **Bench harness consumer orchestration + multi-key cleanup.**
   `services/generator/tools/bench-generator.mjs` today (a) does not pass
   `--stream-shards` through to the generator CLI and (b) only `DEL`s a single
   `streamKey` between samples. The Wave 5.92A hash-tag router writes to N
   derived stream keys, and the Wave 5.92C `MAXLEN` backpressure stalls the
   producer if no consumer is draining. Required precondition (lifted from
   the Wave 5.92D task spec, agreed by the 5.92A+B verifier):

   1. Flush target (`FLUSHALL` on each master, or `DEL` the shard streams +
      any `sens:*` keys).
   2. Start ingest with `STREAM_SHARDS=N SHARD_ASSIGNMENT=all` and wait for
      the N "consumer started" log lines (= `XGROUP CREATE ... $` ran on each
      shard stream — `$` only sees rows produced **after** group creation, so
      starting the producer first strands the first batch as orphan entries
      and the bench under-reports throughput).
   3. Start the generator with `--stream-shards N`.
   4. Wait for drain (`XLEN` per shard → 0).
   5. Record results, then `DEL` every derived stream key (not just the
      base) before the next sample.

## Bench matrix (deferred)

When the two gaps close, run the canonical harness with the matrix from the
Wave 5.92D task spec. Reproducer (copy-paste, run once per cell):

```bash
# Per cell, 10 cold samples each; reports land under docs/recordings/wave-5.92/
for shards in 1 2 4 8; do
  for target in small medium large; do
    STREAM_SHARDS=$shards SHARD_ASSIGNMENT=all \
      node services/generator/tools/bench-generator.mjs \
        --target $target --stream-shards $shards --samples 10 --rounds 1
  done
done
```

Expected reports: `bench-{target}-rows{N}-s10-r1-{ts}.json` per cell, written
by the harness summariser (`writeReport()` in `bench-generator.mjs`). Pin the
median rps / p95 / `memDeltaBytes` columns into the spec's `### Pinned
generator throughput` (M/L rows) and `### Multi-stream scaling` blocks.

## Single-shard re-validation (Wave 5.84D anchor still holds)

The Wave 5.84D `S` row is the authoritative single-shard baseline on this
target and is not re-run here — Wave 5.92A/B/C ship behind a default of
`streamShards=1` (`profile.ts` line ~56) which is bit-identical to the
pre-5.92 code path that produced the 70.55 s / 2,836 rps anchor. The 5.84D
byte-equivalence anchor (`xadd-seed42-rows1000.sha256` =
`47a6a2f27372dcf96fda713015e797f33ada52ecebd6013abb5eba7c219e9025`) covers
the regression check and is re-run on every CI invocation.

## Readiness statement (model-based, pending real-cluster confirmation)

Sizing model lives in spec `## Sizing model (Wave 5.92 audit, anchor: 200k
rows / single-shard Redis Cloud)`. Headline:

- **240M rows on a 16-master cluster ≈ feasible** at ~1.8 TB usable RAM
  (+ replicas → 32 shards billed).
- **Ingest wall-clock at 240M rows** depends linearly on the unmeasured
  per-shard rps `R`. At the single-shard 2,836 rps baseline a single producer
  → single shard run is `240e6 / 2836 ≈ 23.5 h`. Wave 5.92's hash-tag
  fan-out targets near-linear scaling up to `K = master count`, so on a
  16-shard cluster the back-of-envelope projection is
  `≈ 23.5 h / 16 ≈ 1.5 h` once the matrix is captured and confirms the
  scaling factor. Once the bench matrix lands, replace this projection with
  the observed median rps from the K=16 cell.

## What lives in this directory

Today: this README only (no `.json` reports — the matrix is deferred). When
the matrix lands, raw per-sample reports go here as
`bench-{target}-rows{N}-s{samples}-r{rounds}-{ts}.json`.
