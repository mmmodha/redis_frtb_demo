# @frtb/api

Fastify-based control plane for the FRTB SBM workspace. Hosts the
`/ingest/*`, `/generator/*`, `/calc/*`, and `/admin/*` routes that the UI
and the verifier scripts drive.

## POST /ingest/bulk/start — sensitivity_type coverage (Wave 7.0.6.19)

`POST /ingest/bulk/start` now defaults `sensitivity_types` to
`["Delta", "Vega", "Curvature"]` (was `["Delta", "Vega"]`) so the
verifier's 5-combo calc smoke (GIRR Δ/Vega/Curv, EQUITY Δ, FX Δ) has all
the rows it needs after a stock fresh ingest. The route additionally
threads a coverage floor of `max(1, floor(rows / 100))` per
`(risk_class, sensitivity_type)` combo into the row generator when
`rows >= 100` — small smokes (rows=50k forces ≥ 500 emissions per combo,
rows=200 forces ≥ 2) reliably cover every combo even though the underlying
draw is uniform across `classes.length × sensitivity_types.length` combos.
For `workers > 1` the global floor is divided by the worker count (round
up) so the aggregate across stride workers still meets the guarantee. See
`services/generator/README.md` for the generator-side mechanics.

## POST /ingest/bulk/start — coverage floor preserves requested total (Wave 7.0.6.20)

6.19's floor could inflate the actual row count above `rows` (e.g.
`rows=1,000,000 workers=24` produced ~1.22M rows) because the bias-on-pick
path forced the first `floor` emissions per combo on top of the natural
draw. 6.20 makes the floor reallocate within the requested total: the
route pre-computes `plannedRowsByClass` for each worker's stride slice
(single-thread: `[0, rows)`; multi-worker: `[w, w+S, w+2S, …)`) and threads
it into the row-generator so the per-`(risk_class, sensitivity_type)` quotas
sum EXACTLY to the worker's slice. Sum across workers equals `rows`, so the
final flushed count is within `±num_combos` of the request (tolerance budget
for integer rounding across the round-robin; in practice exactly equal).

## GET /pivot — risk_value reconstruction (Wave 7.0.6.23)

The Wave 7.0+ bulk-loader (`services/bulk-loader/src/worker.ts`
`rowToHashFields`) is the canonical ingest path and writes the raw
sensitivity onto the parent `sens:<ulid>` HASH as flattened
`s_<class>_<leg>[_<tenor>]` fields. It does NOT populate the legacy
`{sens:<ulid>}:tenors` sidetable — introducing one would re-create the
brace-wrapped hash-tag key pattern that Wave 6.31 deliberately eliminated
in favour of the ULID-only key shape (uniform CRC16 slot distribution; no
hot-shard risk). Per explicit operator direction for this wave, no new
Redis key may use a `{...}:suffix` companion shape.

`/pivot` accordingly reconstructs `doc.risk_value` from the parent-HASH
fields already in the FT.SEARCH reply (no extra round-trip): per-tenor
classes (GIRR) emit a tenor-keyed object for Delta/Vega and a positional
`{cvr_up: number[], cvr_down: number[]}` for Curvature in
`schema.risk_classes.<rc>.tenor.nodes` order; scalar classes (FX, Equity,
Commodity, CSR) emit `{spot: number}` for Delta/Vega and
`{cvr_up: number, cvr_down: number}` for Curvature. Wave 7.0.6.14's dense
zero-pad surfaces as explicit `0` values for missing tenors so the UI's
index-keyed sparkline always lines up with the schema-declared tenor list.

The sidetable HGETALL fallback is retained verbatim and only runs for
rows that arrive without any `s_*` fields — i.e. pre-7.0 `hash-sidetable`
data still in Redis. After reconstruction the `s_*` fields are stripped
from the response so the response shape stays compatible with
pre-regression `/pivot` consumers (UI JSON drawer, group-by logic).