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
