# Generator distribution modes — Wave 6.39.A

The synthetic FRTB-SA row generator picks each row's `bucket` from the
declared bucket list via one of three sampling modes, selected at runtime
via the `DISTRIBUTION` env var (or `RowGeneratorOptions.distribution` when
called as a library).

## Modes

### `uniform`
Every bucket equally likely regardless of any schema-declared
`bucket_weights`. Recommended for **benchmarks** where shard-share balance
matters and the workload should saturate every Redis Cluster slot evenly.

For `B` buckets each gets `1/B` probability per draw → over `N` rows each
bucket receives ~`N/B` rows ± Poisson jitter.

### `realistic`
Approximates real FRTB book shape: ~5% of activity on sparse single-name
buckets, ~15% on medium-cardinality buckets, and ~80% on dense bulk
buckets. Recommended for **demos** and customer-facing runs where the
narrative wants a Pareto-like long tail.

The bucket list (declared order in the schema YAML) is split into thirds:

| Band   | Bucket indices                       | Share | Per-bucket weight (B=12) |
|--------|--------------------------------------|-------|--------------------------|
| sparse | `[0, ⌊B/3⌋)`                         | 5%    | `0.05 / ⌊B/3⌋` ≈ 0.0125  |
| medium | `[⌊B/3⌋, ⌊2B/3⌋)`                    | 15%   | `0.15 / (⌊2B/3⌋−⌊B/3⌋)` ≈ 0.0375 |
| dense  | `[⌊2B/3⌋, B)`                        | 80%   | `0.80 / (B−⌊2B/3⌋)`  ≈ 0.20  |

A 3-bucket class (GIRR test fixture: `USD/EUR/GBP`) collapses to exactly
`[0.05, 0.15, 0.80]`.

### `pareto`
Honours the schema's per-class `risk_classes.<class>.bucket_weights` map
when present; falls back to uniform when the map is missing or all-zero.
This is the **legacy** behaviour and the default when `distribution` is
unset / undefined — preserves bit-equivalence with every pre-6.39.A
fixture and the rng-isolation canary.

## Env wiring

```sh
GENERATOR_MODE=direct DISTRIBUTION=uniform   STORAGE_FORMAT=hash-sidetable npm run start
GENERATOR_MODE=direct DISTRIBUTION=realistic STORAGE_FORMAT=hash-sidetable npm run start
GENERATOR_MODE=stream DISTRIBUTION=pareto                                  npm run start
```

`DISTRIBUTION` is independent of `GENERATOR_MODE`: both `stream` and
`direct` writers respect it. `STORAGE_FORMAT` is only consumed in
`direct` mode (`stream` mode routes through the ingest consumer, which
resolves its own `STORAGE_FORMAT` env at startup).

## Invariant — single rng() tick per bucket pick

All three modes consume **exactly one** `rng()` draw per row when picking
the bucket, regardless of band partitioning. This preserves the per-class
main-RNG tick budget so the rng-isolation canary in
`services/generator/tests/rng-isolation.test.ts` keeps holding across
mode flips and the downstream `risk_value` / `tenor` / `tag` / `numeric`
sequence stays bit-identical for a given seed when the same bucket is
picked.
