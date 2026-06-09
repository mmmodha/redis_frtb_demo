## Wave 5.96 — storyboard cold/warm capture

Reference response bodies for the Beat 10 narrative in
[`docs/demo/storyboard.md`](../../demo/storyboard.md). Captured against the
200k-row standalone Redis Cloud DB (sibling artefacts under
[`smoke-run-17/`](../smoke-run-17/) and the
[200k sizing artefacts under `wave-5.92/`](../wave-5.92/)):

- `storyboard-cold.json` — `POST /calc/sbm/total` on a cold response cache;
  `performance.cache = "miss"`, all 27 cells freshly computed.
- `storyboard-warm.json` — immediate re-click against the same warm cache;
  `performance.cache = "hit"`, `cache_hits = 27`,
  `original_cumulative_ms` preserved from the cold pass per Wave 5.96F/N.

Headline values (identical across cold + warm because the §21.4(8)
max-over-scenarios charge is deterministic for a fixed corpus):

| Field                               | Value         |
|-------------------------------------|---------------|
| `total_sbm`                         | 196,570.21    |
| `winning_scenario`                  | `high`        |
| `scenario_totals.low`               | 148,885.89    |
| `scenario_totals.medium`            | 171,439.45    |
| `scenario_totals.high`              | 196,570.21    |
| `performance.redis_ops_count`       | 27            |
| `performance.cells_empty`           | 0             |

These pins also feed the Beat 10 cost-economics narration (1.53 GB total
Redis RAM / ~247 MB RediSearch index at 200k rows) — see the Wave 5.92
audit for the corresponding `FT.INFO idx:sens` capture.
