# Demo storyboard — FRTB-SA SBM on Redis (HSBC walkthrough)

**What this demo proves.** A faithful, live implementation of the Basel FRTB Standardised-Approach Sensitivities-Based Method (MAR21 §21.4) running entirely on Redis: tenor-vector sensitivities stored as JSON, bucket discovery via the Redis Query Engine, the per-bucket `K_b` math executed in-database through Redis Functions (Lua), and the cross-bucket aggregation reduced in the API service. Nothing is staged — every number on screen comes from a calc against 2 000 rows ingested moments earlier into a standalone Redis Cloud DB (Redis 8.4.0). Source-of-truth for the live values shown here is [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) (the clause-by-clause pack) and [`docs/recordings/smoke-run-15/`](../recordings/smoke-run-15/) (raw calc JSONs + memory timeline).

---

## Setup beat (≤ 30 s, before the first click)

**On-screen.** Three browser tabs: (1) the Calc panel with risk-class + leg selectors empty, (2) RedisInsight showing the standalone Redis Cloud DB with `idx:sens` present and `num_docs=2000` / `hash_indexing_failures=0`, (3) a terminal with `docker compose ps` showing six containers (`api`, `calc`, `ingest`, `loadgen`, `source`, `ui`) all `Healthy`.

**Presenter says.** "Before I click anything: 2 000 FRTB sensitivities are already in Redis — RediSearch indexed them in real time, zero indexing failures. The standalone Redis Cloud DB is sitting on `used_memory = 14.55 MB`, well inside our 9 MB Δ-over-baseline cap. The math you're about to see is loaded as Redis Functions — there is no Python risk grid behind the curtain."

**Time budget.** 25 s.

---

## Beat 1 — Bucket discovery via the Redis Query Engine (clause-3 prep)

- **On-screen.** Calc panel: presenter selects `risk_class = GIRR`, `leg = Delta`. A small inspector pane next to the form lists the eleven GIRR currency buckets the api discovered: `CHF, USD, AUD, EUR, CAD, OTHER, JPY, NOK, NZD, SEK, GBP`.
- **Presenter says.** "Before any math, the api asks RediSearch which buckets actually contain GIRR Delta rows. Eleven buckets came back — every populated currency. No bucket scan, no app-side index."
- **Basel anchor.** MAR21 §21.4(3) preparation — bucket enumeration drives the per-bucket fanout that feeds the `WS_k = RW_k · s_k` step. Schema definition: [`config/schema/frtb-default.yaml`](../../config/schema/frtb-default.yaml); per-class γ lookup: [`services/api/src/sbm/correlations.ts:9-27`](../../services/api/src/sbm/correlations.ts).
- **Live value to point at.** 11 / 11 GIRR Delta buckets populated, `count > 0` on every one — largest is **EUR with 31 rows**; smallest is CHF with 25 rows ([`smoke-run-15/calc-girr-delta.json`](../recordings/smoke-run-15/calc-girr-delta.json)).
- **Time budget.** 30 s.

---

## Beat 2 — Click Calculate; one FCALL per bucket (clause 3, `WS_k = RW_k · s_k`)

- **On-screen.** Presenter clicks **Calculate**. A request waterfall lights up: eleven near-simultaneous `FCALL sbm_delta_bucket` calls fanning out from the api, each keyed by the `{GIRR:<bucket>}` hash-tag so it lands on the slot owning that bucket. The aggregate timing card lights up: `total_ms = 246.932`, `fanout_ms = 130.034`.
- **Presenter says.** "One click, eleven Lua calls, each one slot-local. Inside the call, every row's tenor-vector sensitivity is multiplied by the regulatory risk weight `RW_k` — that's literally **line 70** of `girr_delta.lua`: `ws = weights[k] * sum_s[k]`."
- **Basel anchor.** MAR21 §21.4(3): `WS_k = RW_k · s_k`. Implementation: [`services/calc/lib/girr_delta.lua:66-72`](../../services/calc/lib/girr_delta.lua), with the multiplication itself on **line 70**.
- **Live value to point at.** EUR bucket `S_b = Σ_k WS_k = 0.214129951` over 31 rows — the largest-magnitude bucket-level weighted-sensitivity sum in this run.
- **Time budget.** 45 s.

---

## Beat 3 — Within-bucket aggregation: `K_b` per bucket (clause 4)

- **On-screen.** The per-bucket table populates with eleven rows of `(bucket, count, S_b, K_b, ms)`. Presenter taps the EUR row to highlight it.
- **Presenter says.** "Each bucket's `K_b` is the within-bucket Basel aggregation — sum of squared weighted sensitivities plus the cross terms weighted by the prescribed ρ. That's the four lines of Lua: cross term on line 74, the ρ-weighted sum on line 76, and the sqrt on line 78. All eleven buckets returned a strictly positive `K_b`."
- **Basel anchor.** MAR21 §21.4(4): `K_b = √(Σ WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l)`. Implementation: [`services/calc/lib/girr_delta.lua:74-78`](../../services/calc/lib/girr_delta.lua).
- **Live value to point at.** EUR `K_b = 0.21329799987045` (the largest `K_b` of the eleven); the smallest populated bucket NZD lands at `K_b = 0.09810227402039`. Eleven buckets, eleven non-zero `K_b` values.
- **Time budget.** 50 s.

---

## Beat 4 — Cross-bucket reduce: the GIRR risk-class charge (clause 5)

- **On-screen.** The "Risk-class charge" tile flips from blank to **`0.46577934393808174`**. Below it, a γ-matrix preview shows the GIRR cross-bucket correlation lookup the reduce step just used.
- **Presenter says.** "The api takes the eleven `K_b` and `S_b` values and runs the cross-bucket reduce — sum of `K_b²` plus the double sum of `γ_bc · S_b · S_c`, single sqrt at the end. That's **line 49** of `reduce.ts`. The γ values come from the schema YAML, not hard-coded — change the schema, the correlations change."
- **Basel anchor.** MAR21 §21.4(5): `Charge = √(Σ_b K_b² + Σ_{b≠c} γ_bc · S_b · S_c)`. Implementation: [`services/api/src/sbm/reduce.ts:36-49`](../../services/api/src/sbm/reduce.ts).
- **Live value to point at.** GIRR Delta `charge = 0.46577934393808174`, returned at `total_ms = 246.932` / `fanout_ms = 130.034`.
- **Time budget.** 50 s.

---

## Beat 5 — The negative-interior fallback (clause 5(b))

- **On-screen.** Presenter switches to a side-panel diff view that shows the two branches of `reduce.ts`: the positive-interior `√sum` at line 49 and the `S_b*` clamp + re-aggregation at lines 51–62. A small badge on the EUR row reads "branch: positive-interior".
- **Presenter says.** "Basel's §21.4(7) says: if the expression inside the sqrt ever goes negative, cap each `S_b` inside ±`K_b` and recompute. That fallback is **lines 51–62** — same γ lookup, same schema, just `S_b*` instead of `S_b`. On this run, the positive-interior branch fired; the fallback is one branch away."
- **Basel anchor.** MAR21 §21.4(7): `S_b* = max(min(S_b, K_b), -K_b)`, then re-aggregate. Implementation: [`services/api/src/sbm/reduce.ts:51-62`](../../services/api/src/sbm/reduce.ts), gated by the `sum >= 0` test on line 49.
- **Live value to point at.** Branch taken on this run: positive-interior at `reduce.ts:49`; sum-under-sqrt = `0.21694... > 0`, so the `0.46577934393808174` you see is the line-49 result, not the line-62 fallback.
- **Time budget.** 30 s.

---

## Beat 6 — The full 6-variant sweep (GIRR / EQUITY / FX × Δ / V)

- **On-screen.** Presenter runs the matrix sweep button; six rows populate in under two seconds wall-clock. The cost-cap tile shows `Δ-over-baseline = 7.270 MB = 80.78 % of the 9 MB cap`.
- **Presenter says.** "Same math, six variants. Every call HTTP 200, every per-bucket count strictly positive, every charge strictly positive. Sum across the six is `67.06`, and we never breached `81 %` of the memory cap."
- **Basel anchor.** Same MAR21 §21.4(3)–(5) path per risk class; per-class γ matrix sourced via [`services/api/src/sbm/correlations.ts:9-27`](../../services/api/src/sbm/correlations.ts) from the schema YAML.
- **Live value to point at.** GIRR Δ `0.4658`, GIRR V `35.5928`, EQUITY Δ `5.3650`, EQUITY V `12.0172`, FX Δ `0.6883`, FX V `12.7275`; per-variant wallclock `298–343 ms`, fanout `122–130 ms`; six-variant total HTTP-200 hit rate `6/6`.
- **Time budget.** 45 s.

---

## Closer beat (≤ 30 s — what production looks like)

**On-screen.** A single slide with three bullets: cluster topology (multi-shard Redis Enterprise with hash-tag locality preserved), the FRTB matrix scope HSBC would want next (curvature, total capital aggregation, vega curvature inter-bucket), and the integration shape (one REST endpoint, JSON in / JSON out, schema in `config/schema/`).

**Presenter says.** "Today you saw the SBM-Delta and SBM-Vega path on a standalone DB with 2 000 rows. The same code runs on a multi-shard Redis Enterprise cluster — the hash-tag locality you saw on line-70 of `girr_delta.lua` is the property that makes that scale-up linear, not a code change. The next slot in the matrix is curvature; the integration surface stays a single POST."

**Time budget.** 25 s.

**Total presenter time across setup + 6 beats + closer: 25 + 30 + 45 + 50 + 50 + 30 + 45 + 25 = 300 s.**

---

## Anticipated questions (HSBC market-risk reviewers)

**Q1 — Why Redis vs a traditional risk grid?** The SBM map step is per-bucket and embarrassingly parallel; pinning each `K_b` calculation to the slot owning that bucket (via the `{risk_class:bucket}` hash tag) removes the network round-trip per row. On this run the per-variant fanout was `122–130 ms` over eleven buckets — the same shape scales linearly on a multi-shard cluster, where each shard does its own `K_b` locally.

**Q2 — How does this handle the curvature charge?** Honestly: it does not, in this MVP. The curvature charge (MAR21 §21.5) needs upward/downward shocked PnLs and a different aggregation; it is the next item on the matrix, not in today's demo. The Lua-function pattern you saw extends to it cleanly (one Function per leg).

**Q3 — What is the scale-up story?** Today's standalone Redis Cloud DB has a 2.5 GB ceiling and we measured `3.72 KB/row` — fine for the PoV, not fine for HSBC's production sensitivity volumes. Production answer is a multi-shard Redis Enterprise cluster: same `FCALL` code, same hash-tag layout, no app-side sharding logic. The math is unchanged.

**Q4 — How do you guarantee math correctness?** Three converging checks: (a) a reference Python SBM oracle the test suite calibrates against, (b) Basel bounds — every `K_b ≥ 0`, every charge `≥ √Σ K_b²` when γ ≥ 0, all enforced as runtime invariants, and (c) the clause-by-clause traceability pack in [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) that maps each MAR21 §21.4 clause to the exact `file:line` implementing it.

**Q5 — How does this integrate with our existing risk plumbing?** One REST endpoint, `POST /calc/sbm`, JSON in, JSON out. The schema (risk classes, buckets, weights, ρ, γ matrices) is a YAML at [`config/schema/frtb-default.yaml`](../../config/schema/frtb-default.yaml) — swap the file, no code change, the loader at `services/api/src/sbm/correlations.ts:9-27` rebuilds the γ lookup at boot.

**Q6 — Where does the negative-interior fallback actually trigger?** It triggers whenever the cross-bucket γ term drives `Σ K_b² + Σ γ_bc · S_b · S_c` negative — typically high-magnitude bucket-level negative `S_b` values with strong positive γ. On today's GIRR Delta run, that branch did not fire (positive-interior won at `reduce.ts:49`). The branch is reachable via the same single `POST /calc/sbm` call and is unit-tested independently.

**Q7 — Why a single `Function` per `(risk_class, leg)` rather than one generic one?** Per-leg specialisation lets the Lua hold the regulatory weight vector and the prescribed ρ as upvalues (the `__GIRR_DELTA_WEIGHTS__` / `__GIRR_DELTA_RHO__` template slots), which removes a hash lookup from the inner loop. The schema YAML is still the single source of truth — the Functions are templated from it at load time.

---

## What this demo deliberately leaves out

- **Curvature charge (MAR21 §21.5).** Needs shocked PnLs, not sensitivities; not in the MVP.
- **Total capital aggregation across risk classes.** Today we show per-risk-class charges; the trading-book total under MAR21 §21.4(8) (sum-of-squares across risk classes) is a one-line addition we have not lit up.
- **Vega curvature inter-bucket structure.** Vega is included; the curvature × vega interaction is not.
- **Multi-currency normalisation edges.** Cross-currency basis handling and FX-triangulation edge cases are out of scope for this PoV — the standalone DB has zero FX-pair rows beyond the prescribed buckets.
- **Default-risk (DRC) and residual-risk (RRAO) add-ons.** Both are part of FRTB-SA but outside SBM; not touched here.

---

## Footer — supporting artefacts

- Clause-by-clause traceability: [`docs/demo/mar21-traceability.md`](./mar21-traceability.md).
- Run verdict + memory timeline + calc matrix: [`docs/recordings/smoke-run-15/SUMMARY.md`](../recordings/smoke-run-15/SUMMARY.md).
- Raw calc JSONs (six variants + aggregate): [`docs/recordings/smoke-run-15/`](../recordings/smoke-run-15/) — `calc-girr-delta.json`, `calc-girr-vega.json`, `calc-equity-delta.json`, `calc-equity-vega.json`, `calc-fx-delta.json`, `calc-fx-vega.json`, `calc-results.json`.
- Spec context: workspace note id `spec` (FRTB SBM Redis PoV — HSBC).
