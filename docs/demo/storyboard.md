# Demo storyboard — FRTB-SA SBM on Redis (Tier-1 bank walkthrough)

**What this demo proves.** A faithful, live implementation of the Basel FRTB Standardised-Approach Sensitivities-Based Method (MAR21 §21.4 Delta + Vega and §21.5 Curvature) running entirely on Redis: tenor-vector sensitivities and Curvature CVR pairs stored as JSON, bucket discovery via the Redis Query Engine, the per-bucket `K_b` math executed in-database through Redis Functions (Lua), and the cross-bucket aggregation reduced in the API service. Nothing is staged — every number on screen comes from a calc against 6,000 rows (2,000 each for Delta, Vega, Curvature) ingested moments earlier into a standalone Redis Cloud DB (Redis 8.4.0). Source-of-truth for the live values shown here is [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) (the clause-by-clause pack covering §21.4 and §21.5) and [`docs/recordings/smoke-run-17/`](../recordings/smoke-run-17/) (raw calc JSONs + memory timeline + the 9-variant aggregate).

---

## Setup beat (≤ 30 s, before the first click)

**On-screen.** Three browser tabs: (1) the Calc panel with risk-class + leg selectors empty, (2) RedisInsight showing the standalone Redis Cloud DB with `idx:sens` present and `num_docs=6000` / `hash_indexing_failures=0`, (3) a terminal with `docker compose ps` showing six containers (`api`, `calc`, `ingest`, `loadgen`, `source`, `ui`) all `Healthy`.

**Presenter says.** "Before I click anything: 6,000 FRTB sensitivities are already in Redis — 2,000 Delta rows, 2,000 Vega rows, 2,000 Curvature rows. RediSearch indexed them in real time, zero indexing failures. The standalone Redis Cloud DB is sitting at Δ-over-baseline = 23.99 MB = 79.96 % of our 30 MB cap. The math you're about to see is loaded as Redis Functions — there is no Python risk grid behind the curtain, and there is no pre-canned result."

**Time budget.** 25 s.

---

## Beat 1 — Bucket discovery via the Redis Query Engine (clause-3 prep)

- **On-screen.** Calc panel: presenter selects `risk_class = GIRR`, `leg = Delta`. A small inspector pane next to the form lists the eleven GIRR currency buckets the api discovered: `CHF, USD, AUD, EUR, CAD, OTHER, JPY, NOK, NZD, SEK, GBP`.
- **Presenter says.** "Before any math, the api asks RediSearch which buckets actually contain GIRR Delta rows. Eleven buckets came back — every populated currency. No bucket scan, no app-side index."
- **Basel anchor.** MAR21 §21.4(3) preparation — bucket enumeration drives the per-bucket fanout that feeds the `WS_k = RW_k · s_k` step. Schema definition: [`config/schema/frtb-default.yaml`](../../config/schema/frtb-default.yaml); per-class γ lookup: [`services/api/src/sbm/correlations.ts:9-27`](../../services/api/src/sbm/correlations.ts).
- **Live value to point at.** 11 / 11 GIRR Delta buckets populated, `count > 0` on every one — largest is **CAD with 59 rows**; smallest sits around 50 rows ([`smoke-run-16/calc/calc-GIRR-Delta.json`](../recordings/smoke-run-16/calc/calc-GIRR-Delta.json)).
- **Time budget.** 30 s.

---

## Beat 2 — Click Calculate; one FCALL per bucket (clause 3, `WS_k = RW_k · s_k`)

- **On-screen.** Presenter clicks **Calculate**. A request waterfall lights up: eleven near-simultaneous `FCALL sbm_delta_bucket` calls fanning out from the api, each keyed by the `{GIRR:<bucket>}` hash-tag so it lands on the slot owning that bucket. The aggregate timing card lights up: `total_ms ≈ 296`, `fanout_ms ≈ 174`.
- **Presenter says.** "One click, eleven Lua calls, each one slot-local. Inside the call, every row's tenor-vector sensitivity is multiplied by the regulatory risk weight `RW_k` — that's literally **line 70** of `girr_delta.lua`: `ws = weights[k] * sum_s[k]`."
- **Basel anchor.** MAR21 §21.4(3): `WS_k = RW_k · s_k`. Implementation: [`services/calc/lib/girr_delta.lua:66-72`](../../services/calc/lib/girr_delta.lua), with the multiplication itself on **line 70**.
- **Live value to point at.** CAD bucket `S_b = Σ_k WS_k = 0.41033` over 59 rows — the largest-magnitude bucket-level weighted-sensitivity sum in this run.
- **Time budget.** 40 s.

---

## Beat 3 — Within-bucket aggregation: `K_b` per bucket (clause 4)

- **On-screen.** The per-bucket table populates with eleven rows of `(bucket, count, S_b, K_b, ms)`. Presenter taps the CAD row to highlight it.
- **Presenter says.** "Each bucket's `K_b` is the within-bucket Basel aggregation — sum of squared weighted sensitivities plus the cross terms weighted by the prescribed ρ. That's the four lines of Lua: cross term on line 74, the ρ-weighted sum on line 76, and the sqrt on line 78. All eleven buckets returned a strictly positive `K_b`."
- **Basel anchor.** MAR21 §21.4(4): `K_b = √(Σ WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l)`. Implementation: [`services/calc/lib/girr_delta.lua:74-78`](../../services/calc/lib/girr_delta.lua).
- **Live value to point at.** CAD `K_b = 0.40871` (the largest `K_b` of the eleven); SEK lands at `K_b = 0.26069` and JPY at `K_b = 0.23056`. Eleven buckets, eleven non-zero `K_b` values.
- **Time budget.** 40 s.

---

## Beat 4 — Cross-bucket reduce: the GIRR Delta risk-class charge (clause 5)

- **On-screen.** The "Risk-class charge" tile flips from blank to **`0.6846`** (raw `0.6846307166088303`). Below it, a γ-matrix preview shows the GIRR cross-bucket correlation lookup the reduce step just used.
- **Presenter says.** "The api takes the eleven `K_b` and `S_b` values and runs the cross-bucket reduce — sum of `K_b²` plus the double sum of `γ_bc · S_b · S_c`, single sqrt at the end. That's **line 49** of `reduce.ts`. The γ values come from the schema YAML, not hard-coded — change the schema, the correlations change."
- **Basel anchor.** MAR21 §21.4(5): `Charge = √(Σ_b K_b² + Σ_{b≠c} γ_bc · S_b · S_c)`. Implementation: [`services/api/src/sbm/reduce.ts:36-49`](../../services/api/src/sbm/reduce.ts).
- **Live value to point at.** GIRR Delta `charge = 0.6846`, returned at `total_ms ≈ 301` / `fanout_ms ≈ 177`.
- **Time budget.** 40 s.

---

## Beat 5 — The negative-interior fallback (§21.4(7))

- **On-screen.** Presenter switches to a side-panel diff view that shows the two branches of `reduce.ts`: the positive-interior `√sum` at line 49 and the `S_b*` clamp + re-aggregation at lines 51–62. A small badge on the CAD row reads "branch: positive-interior".
- **Presenter says.** "Basel's §21.4(7) says: if the expression inside the sqrt ever goes negative, cap each `S_b` inside ±`K_b` and recompute. That fallback is **lines 51–62** — same γ lookup, same schema, just `S_b*` instead of `S_b`. On this run, the positive-interior branch fired; the fallback is one branch away."
- **Basel anchor.** MAR21 §21.4(7): `S_b* = max(min(S_b, K_b), -K_b)`, then re-aggregate. Implementation: [`services/api/src/sbm/reduce.ts:51-62`](../../services/api/src/sbm/reduce.ts), gated by the `sum >= 0` test on line 49.
- **Live value to point at.** Branch taken on this run: positive-interior at `reduce.ts:49`; sum-under-sqrt > 0, so the `0.6846` you see is the line-49 result, not the line-62 fallback.
- **Time budget.** 25 s.

---

## Beat 6 — Pivot to Curvature: §21.5(2) CVR pairs in the row shape

- **On-screen.** Presenter switches `leg = Curvature` in the Calc panel and opens a side pane on `config/schema/frtb-default.yaml` lines 25–28. The schema preview reads: `Curvature (shape A): GIRR → {cvr_up: array<number>, cvr_down: array<number>}; Equity / FX → {cvr_up: number, cvr_down: number}`. A row inspector shows a sample GIRR Curvature row with the full `{cvr_up[], cvr_down[]}` tenor vector populated.
- **Presenter says.** "Curvature isn't Delta with a different weight. Each row carries Basel's pre-computed `CVR_k` for the up and down shock already — that's clause 2: `CVR_k^{±} = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]`. The upstream pricing layer materialises the bracketed term; the row hits Redis with `{cvr_up, cvr_down}` already populated. The Lua kernel sums those per tenor across all rows in the bucket — that's **line 48** of `girr_curvature.lua`, gated on `sensitivity_type == 'Curvature'`."
- **Basel anchor.** MAR21 §21.5(2): `CVR_k^{up|down} = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]`. Implementation: [`services/calc/lib/girr_curvature.lua:48-71`](../../services/calc/lib/girr_curvature.lua) (per-tenor `sum_up[k]` / `sum_down[k]` aggregation); schema contract at [`config/schema/frtb-default.yaml:25-28`](../../config/schema/frtb-default.yaml).
- **Live value to point at.** GIRR Curvature: 11 / 11 buckets populated, `count > 0` everywhere; row counts per bucket range from AUD = 68 down to EUR = 54, summing to the 667 GIRR rows of the 2 000-row Curvature ingest leg.
- **Time budget.** 40 s.

---

## Beat 7 — Within-bucket K_b for Curvature: §21.5(3) up / down + ψ gate

- **On-screen.** The per-bucket Curvature table populates: eleven rows of `(bucket, count, S_b, K_b, ms)`. Presenter highlights the CAD row.
- **Presenter says.** "Inside the bucket, §21.5(3) builds K_b in two passes — once for the up-shock CVRs, once for the down-shock CVRs — and takes the worse: `K_b^{up|down}² = max(0, Σ_k CVR_k² + Σ_{k≠l} ρ_curv · CVR_k · CVR_l · ψ(CVR_k, CVR_l))` with `ρ_curv = (ρ_delta)² = 0.99² = 0.9801`, then `K_b = max(K_b^up, K_b^down)`. S_b is the directional sum `Σ_k CVR_k` of whichever side won (tie defaults to up). The ψ gate matters **here**, not just at the cross-bucket reduce — `ψ = 0` whenever **both** CVRs in a pair are strictly negative, dropping that cross-tenor pair from the sum. That guard is the one-liner at **line 89** of `girr_curvature.lua` inside `_curv_kb_sq`. It lights up again at the §21.5(5) reduce — `curvatureCommon.ts:121` — gating bucket-pair contributions there too. So ψ is a two-layer guard, not a single cross-bucket switch."
- **Basel anchor.** MAR21 §21.5(3): `K_b = max(K_b^up, K_b^down)` where `K_b^{up|down}² = max(0, Σ_k CVR_k² + Σ_{k≠l} ρ_kl^curv · CVR_k · CVR_l · ψ(CVR_k, CVR_l))`, `ρ_kl^curv = (ρ_kl^delta)²`, `ψ(a,b) = 0 iff (a<0 ∧ b<0) else 1`. Implementation: [`services/calc/lib/girr_curvature.lua:78-96`](../../services/calc/lib/girr_curvature.lua) (`_curv_kb_sq` — ψ at line 89; line 84 accumulates `sum_sq = Σ CVR_k²`; line 90 adds the ρ-weighted cross only when ψ allows); direction pick + max selection at [`girr_curvature.lua:107-127`](../../services/calc/lib/girr_curvature.lua) (lines 108-109 compute both `kb_up_sq` / `kb_down_sq`, lines 121-127 pick the larger and emit `direction`). Shared TS kernel at [`services/calc/src/curvatureCommon.ts:62-78`](../../services/calc/src/curvatureCommon.ts) (`kbSquaredForDirection`, ψ at `:55-57`).
- **Live value to point at.** GIRR Curvature top three: AUD `K_b = 1841.30` / `S_b = 1857.91` / count 68; CAD `K_b = 1797.30` / `S_b = 1813.57` / count 67; NZD `K_b = 1776.51` / `S_b = 1792.53` / count 67. Every bucket strictly positive; ρ_curv = 0.9801. The FCALL computes both `K_b^up` and `K_b^down` internally and ships only the winner — the response surface stays identical to Delta/Vega, but `direction` is logged inside the Lua kernel for trace purposes.
- **Time budget.** 35 s.

---

## Beat 8 — Cross-bucket reduce for Curvature: §21.5(5) + ψ asymmetry gate

- **On-screen.** The "Risk-class charge" tile for GIRR Curvature flips to **`9,495.23`** (raw `9495.234078557116`). Beside it, a small inspector renders the ψ gate test: `ψ(S_b, S_c) = 0 if (S_b < 0 ∧ S_c < 0) else 1`.
- **Presenter says.** "The cross-bucket reduce here is §21.5(5): `√max(0, Σ K_b² + Σ_{b≠c} γ²_bc · S_b · S_c · ψ(S_b, S_c))`. Two differences from §21.4(5): the γ is squared (Basel's curvature-specific γ_curv), and the ψ gate zeros out pairs where both bucket sums are negative — that's the asymmetry. If the interior ever goes negative, we drop into the §21.5(5)(b) fallback that clips each `S_b` into ±`K_b` and recomputes, mirroring the §21.4(7) shape. That fallback sits at **`curvatureCommon.ts:128-139`**; this run took the positive-interior branch at line 126."
- **Basel anchor.** MAR21 §21.5(5): `Charge = √max(0, Σ K_b² + Σ_{b≠c} γ²_bc · S_b · S_c · ψ(S_b, S_c))`. Implementation: [`services/calc/src/curvatureCommon.ts:103-126`](../../services/calc/src/curvatureCommon.ts) (positive-interior branch); fallback at lines 128-139.
- **Live value to point at.** GIRR Curvature `charge = 9,495.23`; EQUITY Curvature `charge = 367.29`; FX Curvature `charge = 1,036.94`. All three positive-interior, no fallback fired.
- **Time budget.** 35 s.

---

## Beat 9 — Why Curvature dwarfs Delta: the upstream-revaluation framing

- **On-screen.** Presenter pulls up a two-row comparison: `GIRR Delta = 0.6846` vs `GIRR Curvature = 9,495.23` — roughly **four orders of magnitude apart**. Underneath, a one-line annotation: *CVR_k pairs are full upstream revaluations, not RW · sensitivity products*.
- **Presenter says.** "This is the question every reviewer asks first, so let's get ahead of it. GIRR Curvature is 9,495 and GIRR Delta is 0.68 — four orders apart. That is exactly what Basel expects from this methodology. Delta is `RW_k · s_k` — a risk weight times a unit-sensitivity. Curvature is `CVR_k = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]` — a full upstream revaluation gap at the shocked rate. Different units, different scale, by construction. Per §21.5(2), CVR carries notional exposure; Delta carries first-order sensitivity. Seeing a four-orders-of-magnitude gap on a 2 000-row Curvature leg is the methodology working, not a bug."
- **Basel anchor.** MAR21 §21.5(2) (CVR_k as a revaluation gap) vs §21.4(3) (`WS_k = RW_k · s_k`). The unit mismatch is intrinsic to the framework.
- **Live value to point at.** GIRR Delta `0.6846` vs GIRR Curvature `9,495.23` (ratio ≈ 1.4 × 10⁴). Pattern repeats per risk class: EQUITY Δ `6.92` vs EQUITY Curv `367.29` (≈ 53×); FX Δ `1.16` vs FX Curv `1,036.94` (≈ 894×).
- **Time budget.** 35 s.

---

## Beat 10 — The full 9-variant sweep (GIRR / EQUITY / FX × Δ / V / Curvature)

- **On-screen.** Presenter runs the matrix sweep button; nine rows populate in under three seconds wall-clock. The cost-cap tile shows `Δ-over-baseline = 23.99 MB = 79.96 % of the 30 MB cap`. A 3 × 3 charge matrix renders on the right:

| Risk class | Delta | Vega | Curvature | Per-class L2 |
|---|---:|---:|---:|---:|
| **GIRR** | 0.6846 | 52.060 | 9495.234 | **9,495.38** |
| **EQUITY** | 6.9244 | 15.302 | 367.295 | **367.68** |
| **FX** | 1.1553 | 15.404 | 1036.939 | **1,037.05** |
| **Grand L2** | — | — | — | **9,558.91** |

- **Presenter says.** "Same math path, nine variants. Every call HTTP 200, every per-bucket count strictly positive, every charge strictly positive. Per-class L2 across the three legs gives GIRR = 9,495.38, EQUITY = 367.68, FX = 1,037.05; the grand L2 across the three risk classes is **9,558.91**. We never breached 79.96 % of the memory cap."
- **Basel anchor.** Same MAR21 §21.4(3)–(5) path per Delta/Vega; §21.5(2)–(5) path per Curvature; per-class γ matrix sourced via [`services/api/src/sbm/correlations.ts:9-27`](../../services/api/src/sbm/correlations.ts) from the schema YAML.
- **Live value to point at.** Nine-variant total HTTP-200 hit rate `9/9`; per-variant wallclock `263–301 ms`, fanout `149–181 ms`; cap utilisation `23.99 / 30 MB = 79.96 %`. Source: [`docs/recordings/smoke-run-17/aggregate.json`](../recordings/smoke-run-17/aggregate.json).
- **Time budget.** 45 s.

---

## Closer beat (≤ 30 s — what production looks like)

**On-screen.** A single slide with three bullets: cluster topology (multi-shard Redis Enterprise with hash-tag locality preserved), the FRTB matrix scope the bank would want next (§21.6 cross-class total, DRC default-risk charge, RRAO residual-risk add-on), and the integration shape (one REST endpoint, JSON in / JSON out, schema in `config/schema/`).

**Presenter says.** "Today you saw the full SBM-Delta + SBM-Vega + SBM-Curvature path on a standalone DB with 6,000 rows. The same code runs on a multi-shard Redis Enterprise cluster — the hash-tag locality you saw on line-70 of `girr_delta.lua` is the property that makes that scale-up linear, not a code change. The next slots in the matrix are the §21.6 cross-class total (rolling the grand L2 you just saw into a single trading-book number), the default-risk charge (DRC), and the residual-risk add-on (RRAO). The integration surface stays a single POST."

**Time budget.** 25 s.

**Total presenter time across setup + 10 beats + closer: 25 + 30 + 40 + 40 + 40 + 25 + 40 + 35 + 35 + 35 + 45 + 25 = 415 s.**

---

## Anticipated questions (the bank's market-risk reviewers)

**Q1 — Why Redis vs a traditional risk grid?** The SBM map step is per-bucket and embarrassingly parallel; pinning each `K_b` calculation to the slot owning that bucket (via the `{risk_class:bucket}` hash tag) removes the network round-trip per row. On this run the per-variant fanout was `149–181 ms` over eleven (or thirteen, for Equity) buckets — the same shape scales linearly on a multi-shard cluster, where each shard does its own `K_b` locally.

**Q2 — How does this handle the curvature charge?** Yes, end-to-end. §21.5(2) CVR_k pairs are pre-computed upstream and arrive on each row as `{cvr_up, cvr_down}` (per-tenor arrays for GIRR; scalars for Equity / FX). §21.5(3) within-bucket K_b runs slot-local in `girr_curvature.lua` / `equity_curvature.lua` / `fx_curvature.lua`. §21.5(5) cross-bucket reduce — with the squared γ_curv and the ψ asymmetry gate — runs in `services/calc/src/curvatureCommon.ts:103-126`, with the §21.5(5)(b) negative-interior fallback at lines 128-139. Live charges this run: GIRR `9,495.23`, EQUITY `367.29`, FX `1,036.94`.

**Q3 — Why is GIRR Curvature ~10⁴× larger than GIRR Delta?** That gap is structural, not a sign error. Delta is `WS_k = RW_k · s_k` — a risk weight times a unit-sensitivity (§21.4(3)). Curvature is `CVR_k = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]` — a full upstream revaluation gap at the shocked rate (§21.5(2)). Different units, different scale, by Basel's design. On a 2 000-row Curvature leg the GIRR ratio lands near 1.4 × 10⁴; EQUITY ≈ 53×; FX ≈ 894×. That is what regulators expect when CVR pairs are upstream revaluations rather than RW · sensitivity products.

**Q4 — How are you handling §21.5(5)(b)?** Clip-and-recompute mirroring the §21.4(7) shape: when the cross-bucket interior `Σ K_b² + Σ γ²_bc · S_b · S_c · ψ` goes negative, we replace each `S_b` with `S_b* = max(min(S_b, K_b), −K_b)` and re-evaluate the same expression with the same γ_curv and ψ gate. Implementation at [`services/calc/src/curvatureCommon.ts:128-139`](../../services/calc/src/curvatureCommon.ts); the inline comment at [`services/calc/src/curvatureCommon.ts:99`](../../services/calc/src/curvatureCommon.ts) flags this explicitly as a **text-fidelity caveat** — a strict Curvature-only reading of §21.5(5)(b) would clip negatives to 0 instead of to ±K_b. We chose the ±K_b shape for consistency with the §21.4(7) implementation already in production at `services/api/src/sbm/reduce.ts:51-62`, and we have flagged the choice for the bank's business sign-off before production cut-over.

**Q5 — What is the scale-up story?** Today's standalone Redis Cloud DB has a 2.5 GB ceiling and we measured 3.86 KB/row blended (Delta + Vega + Curvature) at 6,000 rows. Production answer is a multi-shard Redis Enterprise cluster: same `FCALL` code, same hash-tag layout, no app-side sharding logic. The math is unchanged.

**Q6 — How do you guarantee math correctness?** Three converging checks: (a) a reference Python SBM oracle the test suite calibrates against (now extended to cover §21.5 Curvature), (b) Basel bounds — every `K_b ≥ 0`, every charge `≥ √Σ K_b²` when the cross term is non-negative, all enforced as runtime invariants, and (c) the clause-by-clause traceability pack in [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) that maps each MAR21 §21.4 and §21.5 clause to the exact `file:line` implementing it.

**Q7 — How does this integrate with our existing risk plumbing?** One REST endpoint, `POST /calc/sbm`, JSON in, JSON out. The schema (risk classes, buckets, weights, ρ, γ matrices, curvature γ_curv) is a YAML at [`config/schema/frtb-default.yaml`](../../config/schema/frtb-default.yaml) — swap the file, no code change, the loader at `services/api/src/sbm/correlations.ts:9-27` rebuilds the γ lookup at boot.

**Q8 — Where does the negative-interior fallback actually trigger?** For §21.4 Delta/Vega it triggers whenever the cross-bucket γ term drives `Σ K_b² + Σ γ_bc · S_b · S_c` negative — typically high-magnitude bucket-level negative `S_b` values with strong positive γ. For §21.5 Curvature it triggers analogously, with the ψ asymmetry gate already in effect. On this run, all nine variants took the positive-interior branch; the fallback branches are reachable via the same single `POST /calc/sbm` call and are unit-tested independently.

**Q9 — Why a single `Function` per `(risk_class, leg)` rather than one generic one?** Per-leg specialisation lets the Lua hold the regulatory weight vector and the prescribed ρ as upvalues (the `__GIRR_DELTA_WEIGHTS__` / `__GIRR_DELTA_RHO__` template slots — and the analogous `__*_CURVATURE_*__` slots for the three Curvature kernels), which removes a hash lookup from the inner loop. The schema YAML is still the single source of truth — the Functions are templated from it at load time.

---

## What this demo deliberately leaves out

- **§21.6 cross-risk-class total capital.** Today we show per-risk-class charges and the grand L2 across GIRR + EQUITY + FX (`9,558.91`); the full §21.6 trading-book total — folding in CSR and Commodity and rolling Delta + Vega + Curvature into one regulator-facing number — is a one-screen extension we have not lit up.
- **Default Risk Charge (DRC).** The non-securitisation / securitisation / CTP default-risk add-on under MAR22 is part of FRTB-SA but outside SBM; not touched here.
- **Residual Risk Add-On (RRAO).** The MAR23 residual-risk add-on (gap / exotic / digital) is similarly outside SBM and not in this demo.
- **Curvature × Vega interaction.** Vega is included as its own leg and Curvature is included as its own leg; the §21.5 Curvature-on-Vega-shock interaction (where Curvature is run against the Vega risk factor rather than the Delta risk factor) is not in this scope.
- **Multi-currency normalisation edges.** Cross-currency basis handling and FX-triangulation edge cases are out of scope for this PoV — the standalone DB has zero FX-pair rows beyond the prescribed buckets.

---

## Footer — supporting artefacts

- Clause-by-clause traceability (§21.4 + §21.5): [`docs/demo/mar21-traceability.md`](./mar21-traceability.md).
- Run verdict + memory timeline + 9-variant calc matrix: [`docs/recordings/smoke-run-17/SUMMARY.md`](../recordings/smoke-run-17/SUMMARY.md).
- Raw calc JSONs (nine variants + aggregate): [`docs/recordings/smoke-run-17/calc/`](../recordings/smoke-run-17/calc/) — `calc-GIRR-Delta.json`, `calc-GIRR-Vega.json`, `calc-GIRR-Curvature.json`, `calc-EQUITY-Delta.json`, `calc-EQUITY-Vega.json`, `calc-EQUITY-Curvature.json`, `calc-FX-Delta.json`, `calc-FX-Vega.json`, `calc-FX-Curvature.json`; plus [`aggregate.json`](../recordings/smoke-run-17/aggregate.json) for the rolled-up 3 × 3 matrix.
- Spec context: workspace note id `spec` (FRTB SBM Redis PoV).
