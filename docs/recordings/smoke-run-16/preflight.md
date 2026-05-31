# Curvature pre-flight — Wave 5.16e1

## Environment
- Endpoint: lip-veil-spring-32424.db.redis.io:14596 (standalone, TLS off)
- REDIS_CLUSTER=false
- Date: 2026-05-31T18:25Z

Note on metric: this Redis Cloud DB's `INFO memory` does NOT expose
`used_memory_dataset` / `used_memory_overhead` / `used_memory_startup` —
only `used_memory` (jemalloc-allocated total) is available. All values
below are `used_memory` bytes, matching the prior 5.15s smoke run's
convention. Allocator overhead is bounded (`mem_fragmentation_ratio=1`)
so `used_memory` Δ is a faithful proxy for the dataset Δ on this DB.

## Measurements (used_memory)
| Stage                           |       Bytes |    MB |
|---------------------------------|------------:|------:|
| B (baseline, post-FLUSHALL)     |   7,694,352 |  7.34 |
| B' (post-bootstrap, api ready)  |   7,878,880 |  7.51 |
| P (post-50-row ingest, indexed) |   8,363,552 |  7.97 |
| Δ_bootstrap (B' − B)            |     184,528 |  0.18 |
| Δ_data (P − B')                 |     484,672 |  0.46 |
| Per-row cost (Δ_data / 50)      |    9,693.44 | **9.47 KB/row** |

Ingest mix: 17 GIRR + 17 EQUITY + 16 FX = 50 Curvature rows. Indexed
state at P: `num_docs=50`, `num_records=217`, `hash_indexing_failures=0`,
`indexing=0` (FT.INFO `idx:sens`). Δ_bootstrap is small because the
post-FLUSHALL baseline (B) was taken after jemalloc lazyfree GC had
already released most of the prior wave's pages; api bootstrap re-used
allocator headroom rather than expanding from the OS. The historic
~4.7 MB bootstrap figure was a 4-shard cluster aggregate — this is a
single-shard standalone, so the empty-index + Lua overhead is well
under 1 MB. FUNCTION LIST persists 43 lines (6 FRTB Lua functions)
across FLUSHALL by design.

## Projection
- 2,000-row Curvature Δ (linear extrapolation: 9,693.44 B/row × 2,000): 18.49 MB
- 5.15s baseline Δ (Delta+Vega @ 2,000 rows): 7.27 MB
- **Total projected 5.16e2 Δ**: **25.76 MB**
- Cap: 25 MB
- **Headroom**: **−0.76 MB** (over cap by ~0.8 MB)

Linear extrapolation is conservative at this sample size: at 50 rows
the per-row cost carries a non-negligible share of fixed scaffolding
(stream radix-tree nodes, FT index meta, jemalloc allocation-class
round-up). Realised 2,000-row cost will likely be lower than the
linear projection — but 5.15s's measured Delta+Vega per-row cost was
3.72 KB/row at 2,000 rows, so a 2-3× ratio for Curvature (justified
by the additional `cvr_up` + `cvr_down` per-tenor arrays on GIRR) is
plausible regardless. Treat 25.76 MB as the upper-bound projection.

## Verdict
🔴 **RED** — linear projection of **25.76 MB > 25 MB cap** (over by 0.76 MB,
under 0 MB headroom). Cannot proceed to 5.16e2 with 2,000 Curvature rows
without breaching the cap; shrink the Curvature row count.

## Recommended action
Reduce 5.16e2's Curvature row count to **N_safe = 1,700 rows** (round
down from 1,701) to preserve a 2 MB headroom under the 25 MB cap.

Derivation:
- Cap minus 2 MB headroom: 25 − 2 = 23 MB = 24,117,248 bytes
- Subtract 5.15s Delta+Vega baseline (7.27 MB = 7,623,600 bytes): 16,493,648 bytes available for Curvature
- 16,493,648 ÷ 9,693.44 B/row = 1,701.5 → **floor to 1,700 rows**
- Resulting projected total Δ at 1,700 rows: 7.27 + 1,700 × 9,693.44 / (1024²) = 7.27 + 15.71 = **22.98 MB** (≈ 2.0 MB headroom, GREEN)

If 1,700 rows is not workable for the demo storyline (e.g. the planned
17/17/16 distribution scales to integer multiples), the closest
distribution-preserving counts are:
- 1,500 rows (500/500/500 GIRR/EQUITY/FX): projected total 7.27 + 13.86 = **21.13 MB** (3.87 MB headroom, GREEN)
- 1,700 rows (≈ 567/567/566): projected total **22.98 MB** (2.02 MB headroom, GREEN borderline)
- 1,800 rows (600/600/600): projected total 7.27 + 16.63 = **23.90 MB** (1.10 MB headroom, YELLOW)

Coordinator decision: pick N from {1,500 | 1,700 | 1,800} based on the
demo-storyline preference. Default recommendation: **1,500 rows** for a
clean ≥ 3 MB GREEN headroom matching the 5.15s safety margin.
