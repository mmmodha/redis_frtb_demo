## `@frtb/ingest` — live-tail stream consumer (Wave 7.0.6)

Stream-based consumer for the **live-tail demo path** (≤ 5K rps). The service
reads sensitivity rows from a Redis Stream consumer group and writes them as
`sens:<ulid>` HSETs (plus the slot-co-located `{sens:<ulid>}:tenors` side-table
when the row carries per-tenor / Curvature / scalar `risk_value` data).

### Role

- **Live-tail path only.** The bulk-loaded baseline (see `services/bulk-loader/`)
  owns the rollup / seen-set / processed-marker materialisation post-load via
  its tag-free finalisation step.
- **Sens-only writes.** Calc / lazy-math computes everything on the fly from
  `idx:sens:slim` via FT.AGGREGATE — no incremental rollup update is needed on
  the live-tail path. This eliminates the live-tail dependency on `{...}`
  hash-tagged rollup/processed keys entirely.
- **Hot path:** `XREADGROUP` → per-row `HSET sens:<ulid> …` (+ optional
  side-table `HSET {sens:<ulid>}:tenors …`) → `XACK`.

### Modes

The consumer has two write-path modes selected at boot via `LIVE_TAIL_MODE`:

| Env                  | Write paths                                                                                  | When to use                       |
|----------------------|----------------------------------------------------------------------------------------------|-----------------------------------|
| `LIVE_TAIL_MODE=1`   | Only `sens:<ulid>` (+ slot-local `{sens:<ulid>}:tenors`) HSET; XACK                          | Production live-tail demo path    |
| _(unset / `0`)_      | Legacy: `sens:*` + `rollup:*` + `seen:*` + `processed:*` + `sug:*` (full Route-D 3-phase)    | Parity testing / pre-7.0.6 callers |

In live-tail mode the following write paths are gated **off**:

- `rollup:<rc>:<bkt>:<sens>` HINCRBYFLOATs (per-bucket and per-tenor sub-rollups)
- `seen:risk_class` / `seen:bucket:{<rc>}` / `seen:sens_type:{<rc>:<bkt>}` SADDs
- `processed:{<rc>:<bkt>}:<entryId>` idempotency-marker SETs (no longer needed —
  there's no rollup write to dedupe against)
- `sug:book` / `sug:trade_id` / `sug:risk_factor` FT.SUGADDs

XACK still fires so the consumer-group PEL drains. The flag is read on every
batch from `process.env.LIVE_TAIL_MODE` (parsed via `resolveLiveTailMode` —
accepts `1` / `true` / `yes` / `on`); the boot log emits a single line when
the flag is set so the run mode is operator-visible.

### Verification

Live-tail mode (acceptance check from Wave 7.0.6 DoD):

```sh
LIVE_TAIL_MODE=1 REDIS_URL=redis://localhost:6379 \
  SCHEMA_FILE=config/schema/frtb-default.yaml \
  pnpm -F @frtb/ingest dev
# Push 1000 rows via the generator or producer panel, then:
redis-cli --scan --pattern 'rollup:*'    # → empty
redis-cli --scan --pattern 'seen:*'      # → empty
redis-cli --scan --pattern 'processed:*' # → empty
redis-cli --scan --pattern 'sens:*'      # → 1000 keys
```

Legacy parity (flag off): existing unit and integration tests in
`tests/consumer.test.ts` and `tests/delta-reconcile.test.ts` continue to assert
the full 3-phase Route-D contract.

### Key env vars

- `REDIS_URL` — target Redis (standalone or `redis-cluster://`)
- `STREAM_KEY` — stream name (default `sensitivities:in`)
- `CONSUMER_GROUP` — group name (default `ingest`)
- `STREAM_SHARDS` / `SHARD_ASSIGNMENT` — stream-shard fan-out (Wave 5.92B)
- `STORAGE_FORMAT` — one of `hash-sidetable` (default), `hash-encoded`, `json`,
  `json-shadow-hash` (Wave 6.38.A)
- `LIVE_TAIL_MODE` — `1` / `true` to enable sens-only mode (this wave)
- `SCHEMA_FILE` — path to the FRTB schema YAML (default
  `config/schema/frtb-default.yaml`)
