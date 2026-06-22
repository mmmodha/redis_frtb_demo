# @frtb/generator

Schema-driven synthetic-row generator for FRTB SBM smokes. Drives the
`/ingest/bulk/start` and `/generator/start` routes plus the standalone CLI.

## Sensitivity_type coverage floor (Wave 7.0.6.19)

When `RowGenerator` is constructed with `coverageFloor: N` (N > 0) AND more
than one `sensitivityTypes` value is configured, the first `N` rows of each
`(risk_class, sensitivity_type)` combo are forced in the order
`sensitivityTypes` was declared (Delta, Vega, Curvature, …) before the loop
reverts to the legacy uniform-random pick. Counters are tracked per
`risk_class` so a round-robin `classes[i % classes.length]` caller (the
default in coordinator/worker) reaches every combo independently. The pick
always consumes exactly one `rng()` tick so the rng-isolation canary and
the `--workers 1` byte-equivalence canary continue to hold for the default
path (`coverageFloor` undefined or `0`).

Callers compute the floor as `max(1, floor(rowsTotal / 100))` for
`rowsTotal >= 100` (disabled below that); multi-worker callers divide by
`totalWorkers` (round up) so the aggregate across stride workers meets the
global guarantee. The bulk-ingest route (`POST /ingest/bulk/start`) wires
this automatically — a `rows=50000` run forces ≥ 500 emissions per combo,
which closes the verifier-Step-6 gap where 50k bulk runs could emit ZERO
GIRR Curvature rows because the uniform 1/(3·3) draw missed the combo.

## Coverage floor reallocates within the requested total (Wave 7.0.6.20)

The 6.19 bias-on-pick path could let the floor inflate the row count above
the requested total when `floor × num_combos` exceeded the natural per-combo
share (e.g. `rows=1,000,000 workers=24` produced ~1.22M rows). 6.20 fixes
this by accepting an optional `plannedRowsByClass` (the per-risk_class row
count the caller will actually request from this generator instance). When
supplied, `createRowGenerator` pre-computes a per-`(risk_class, sensitivity_type)`
quota table via `computeCoverageQuotas(plannedRows, n, floor)` that sums
EXACTLY to `plannedRows` and meets `min(floor, ⌊plannedRows / n⌋)` per combo
(steals from the surplus combo to satisfy below-floor combos). `generate()`
then picks the sens_type with the largest remaining quota and decrements,
still consuming one `rng()` tick so the rng-isolation invariant on the
downstream bucket/risk_value draws is preserved.

Net effect: the actual row total is within `±num_combos` of the requested
total (in practice, exactly equal for stride=1 round-robin callers). The
6.19 bias-on-pick path remains as a back-compat fallback when
`plannedRowsByClass` is absent.