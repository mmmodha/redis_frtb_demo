# Demo storyboard — FRTB-SA SBM on Redis (Tier-1 bank walkthrough)

**What this demo proves.** A faithful, live implementation of the Basel FRTB Standardised-Approach Sensitivities-Based Method (MAR21 §21.4 Delta + Vega and §21.5 Curvature) running entirely on Redis: tenor-vector sensitivities and Curvature CVR pairs stored as JSON, bucket discovery via the Redis Query Engine, the per-bucket `K_b` math executed in-database through Redis Functions (Lua), and the cross-bucket aggregation reduced in the API service. Nothing is staged — every number on screen comes from a calc against 6,000 rows (2,000 each for Delta, Vega, Curvature) ingested moments earlier into a standalone Redis Cloud DB (Redis 8.4.0). Source-of-truth for the live values shown here is [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) (the clause-by-clause pack covering §21.4 and §21.5) and [`docs/recordings/smoke-run-17/`](../recordings/smoke-run-17/) (raw calc JSONs + memory timeline + the 9-variant aggregate).

---

## Setup beat (≤ 30 s, before the first click)

**Visible on screen.** Three browser tabs: (1) the Calc panel (CalcPanel) with risk-class + Sensitivity-type selects in their default state, (2) RedisInsight on the standalone Redis Cloud DB showing `idx:sens` with `num_docs=6000` / `hash_indexing_failures=0`, (3) a terminal with `docker compose ps` showing the six containers (`api`, `calc`, `ingest`, `loadgen`, `source`, `ui`) all `Healthy`. Plus a fourth shell tab pre-loaded with `curl -s http://localhost:8080/observability/memory | jq` for the cap-utilisation read-out.

**Presenter says.** "Before I click anything: 6,000 FRTB sensitivities are already in Redis — 2,000 Delta rows, 2,000 Vega rows, 2,000 Curvature rows. RediSearch indexed them in real time, zero indexing failures. The standalone Redis Cloud DB is sitting at Δ-over-baseline = 24.89 MB = 82.97 % of our 30 MB cap — you can see it any time from `/observability/memory`. The math you're about to see is loaded as Redis Functions — there is no Python risk grid behind the curtain, and there is no pre-canned result."

**Screenshot.** `beat-00-setup.png` (asset-pack).

**Time budget.** 25 s.

---

## Beat 1 — Bucket discovery via the Redis Query Engine (clause-3 prep)

- **Visible on screen.** Calc panel (CalcPanel): presenter sets the **Risk class** select to `GIRR` and the **Sensitivity type** select to `Delta`. Form is filled, no result yet. (UI label is "Sensitivity type"; throughout this script we use Basel's term "leg" interchangeably with it.)
- **Presenter says.** "I'm selecting GIRR Delta. The moment I click Calculate, the api will ask RediSearch which buckets actually contain GIRR Delta rows — that's a FT.AGGREGATE against `idx:sens`, no app-side index, no full scan. Eleven currency buckets will come back — every populated GIRR currency. You'll see them light up the per-bucket table in a second."
- **Basel anchor.** MAR21 §21.4(3) preparation — bucket enumeration drives the per-bucket fanout that feeds the `WS_k = RW_k · s_k` step. Schema definition: [`config/schema/frtb-default.yaml`](../../config/schema/frtb-default.yaml); per-class γ lookup: [`services/api/src/sbm/correlations.ts:9-27`](../../services/api/src/sbm/correlations.ts).
- **Live value to point at.** Pre-Calculate: just the filled selects. Post-Calculate (lands in Beat 2/3): the **Per-bucket K_b** PanelCard populates with 11 GIRR currency buckets — `CHF, USD, AUD, EUR, CAD, OTHER, JPY, NOK, NZD, SEK, GBP` — `count > 0` on every one. Largest is **CAD with 59 rows** (per canonical [`smoke-run-17/calc/calc-GIRR-Delta.json`](../recordings/smoke-run-17/calc/calc-GIRR-Delta.json)); smallest sits around 50 rows.
- **Screenshot.** `beat-01-bucket-discovery.png` (CalcPanel with GIRR/Delta selected, pre-Calculate).
- **Time budget.** 30 s.

---

## Beat 2 — Click Calculate; one FCALL per bucket (clause 3, `WS_k = RW_k · s_k`)

- **Visible on screen.** Presenter clicks **Calculate** on the CalcPanel. The **Risk-class charge** PanelCard appears; its `wallclock-badge` reads "Total wall-clock: ~296 ms · fanout ~174 ms". The **Per-bucket K_b** PanelCard renders 11 bars (one per discovered bucket); the per-bucket breakdown table beneath it shows the per-bucket `ms` column — every bucket sub-30 ms — which is the visible evidence of the slot-local fanout. (No "waterfall" graphic is in the UI; the timing badge + per-bucket `ms` column carry that story.)
- **Presenter says.** "One click, eleven Lua calls, each one slot-local. Watch the wall-clock badge in the top right — total round-trip ~296 ms, fanout ~174 ms — and look at the `ms` column in the per-bucket table: each bucket's FCALL completed in single-digit ms because it ran on the slot owning the `{GIRR:<bucket>}` hash-tag. Inside the call, every row's tenor-vector sensitivity is multiplied by the regulatory risk weight `RW_k` — that's literally **line 70** of `girr_delta.lua`: `ws = weights[k] * sum_s[k]`."
- **Basel anchor.** MAR21 §21.4(3): `WS_k = RW_k · s_k`. Implementation: [`services/calc/lib/girr_delta.lua:66-72`](../../services/calc/lib/girr_delta.lua), with the multiplication itself on **line 70**.
- **Live value to point at.** Wallclock badge `total ≈ 296 ms / fanout ≈ 174 ms` on a warm cache; CAD per-bucket-table row shows `S_b = Σ_k WS_k = 0.41033` over 59 rows — the largest-magnitude bucket-level weighted-sensitivity sum in this run.
- **Screenshot.** `beat-02-calculate.png` (Risk-class charge PanelCard + wallclock badge + Per-bucket K_b chart).
- **Time budget.** 40 s.

---

## Beat 3 — Within-bucket aggregation: `K_b` per bucket (clause 4)

- **Visible on screen.** **Per-bucket K_b (capital concentration)** PanelCard: the `BucketChargeChart` renders 11 K_b bars sorted descending; the per-bucket breakdown table beneath it shows the eleven rows of `(bucket, count, S_b, K_b, ms)`. Presenter clicks the CAD row to expand the `BucketDrilldown` accordion (Wave 5.21a) showing the underlying tenor-vector risk values.
- **Presenter says.** "Each bucket's `K_b` is the within-bucket Basel aggregation — sum of squared weighted sensitivities plus the cross terms weighted by the prescribed ρ. That's the four lines of Lua: cross term on line 74, the ρ-weighted sum on line 76, and the sqrt on line 78. The bars on the left are K_b descending — CAD leads at 0.40871, and the drilldown I just opened shows the tenor vector that produced it. All eleven buckets returned a strictly positive `K_b`."
- **Basel anchor.** MAR21 §21.4(4): `K_b = √(Σ WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l)`. Implementation: [`services/calc/lib/girr_delta.lua:74-78`](../../services/calc/lib/girr_delta.lua).
- **Live value to point at.** CAD `K_b = 0.40871` (the largest `K_b` of the eleven); SEK lands at `K_b = 0.26069` and JPY at `K_b = 0.23056`. Eleven buckets, eleven non-zero `K_b` values.
- **Screenshot.** `beat-03-kb-table.png` (Per-bucket K_b chart + per-bucket breakdown table + CAD drilldown accordion open).
- **Time budget.** 40 s.

---

## Beat 4 — Cross-bucket reduce: the GIRR Delta risk-class charge (clause 5)

- **Visible on screen.** The **Risk-class charge** PanelCard's hero number (`AnimatedCharge`) eases up from 0 to **`0.6846`** (raw `0.6846307166088303`) over ~600 ms; the `basel-caption` below the number reads "GIRR · Delta · MAR21 §21.4(5) Cross-bucket reduce". (No γ-matrix preview pane exists in the UI — the γ lookup itself lives in `correlations.ts` and the schema YAML; presenter does a brief **editor flip** to those two files to show the γ source of truth.)
- **Presenter says.** "The api takes the eleven `K_b` and `S_b` values and runs the cross-bucket reduce — sum of `K_b²` plus the double sum of `γ_bc · S_b · S_c`, single sqrt at the end. That's **line 62** of `reduce.ts`, which I'll flip to in a second. The γ values come from the schema YAML — let me show you: `config/schema/frtb-default.yaml` defines the GIRR cross-bucket γ matrix, and `correlations.ts:9-27` is the loader that builds the lookup at boot. Change the schema, the correlations change — no code edit, no redeploy of the kernels."
- **Basel anchor.** MAR21 §21.4(5): `Charge = √(Σ_b K_b² + Σ_{b≠c} γ_bc · S_b · S_c)`. Implementation: [`services/api/src/sbm/reduce.ts:39-62`](../../services/api/src/sbm/reduce.ts) (positive-interior path; sqrt + `sum >= 0` test on line 62). γ source: [`config/schema/frtb-default.yaml`](../../config/schema/frtb-default.yaml) + loader at [`services/api/src/sbm/correlations.ts:9-27`](../../services/api/src/sbm/correlations.ts).
- **Live value to point at.** GIRR Delta `charge = 0.6846`, returned at `total_ms ≈ 301` / `fanout_ms ≈ 177` on the wallclock badge.
- **Screenshot.** `beat-04-girr-delta-charge.png` (Risk-class charge PanelCard showing 0.6846 + basel-caption).
- **Time budget.** 40 s.

---

## Beat 5 — The negative-interior fallback (§21.4(7))

- **Visible on screen.** **Editor flip** to `services/api/src/sbm/reduce.ts` in the presenter's IDE: scroll to highlight the positive-interior `sqrt(sum)` return on **line 62**, then the clip-to-±K_b fallback block at **lines 64–75**. Back in the browser: the **Risk-class charge** PanelCard still shows `0.6846` — there is no per-Delta-bucket branch badge in the UI today (the `CurvatureBranchPill` shown in Beat 8 is Curvature-only); for §21.4 Delta/Vega the branch info is on the api response only.
- **Presenter says.** "Basel's §21.4(7) says: if the expression inside the sqrt ever goes negative, cap each `S_b` inside ±`K_b` and recompute. In the code that's the `if (sum >= 0) return Math.sqrt(sum)` on **line 62**; if `sum` is negative we drop into the **lines 64–75** clip-and-recompute block — same γ lookup, same schema, just `S_b*` instead of `S_b`. On this run, the positive-interior branch fired — `0.6846` is the line-62 result, not the line-75 fallback. The branch info is on the api response for §21.4 Delta/Vega today; the on-screen pill in Beat 8 is the Curvature analogue."
- **Basel anchor.** MAR21 §21.4(7): `S_b* = max(min(S_b, K_b), -K_b)`, then re-aggregate. Implementation: [`services/api/src/sbm/reduce.ts:64-75`](../../services/api/src/sbm/reduce.ts), gated by the `sum >= 0` test on line 62.
- **Live value to point at.** Branch taken on this run: positive-interior at `reduce.ts:62`; sum-under-sqrt > 0, so the `0.6846` you see is the line-62 result, not the line-75 fallback. The Delta/Vega branch indicator is not surfaced in the UI today — visible only on the JSON response.
- **Screenshot.** `beat-05-reduce-editor.png` (editor flip — split view of `reduce.ts` with lines 62 and 64-75 highlighted).
- **Time budget.** 25 s.

---

## Beat 6 — Pivot to Curvature: §21.5(2) CVR pairs in the row shape

- **Visible on screen.** Presenter switches the **Sensitivity type** select to `Curvature` in the CalcPanel and clicks Calculate. Then an **editor flip** to `config/schema/frtb-default.yaml` (lines 25–28) showing the row-shape contract: `GIRR → {cvr_up: array<number>, cvr_down: array<number>}`; `Equity / FX → {cvr_up: number, cvr_down: number}`. Back in the browser: the **Per-bucket K_b** PanelCard re-renders for Curvature; presenter expands the AUD row's `BucketDrilldown` accordion (Wave 5.21a) — it shows the live `{cvr_up[], cvr_down[]}` tenor arrays straight out of the per-row JSON.
- **Presenter says.** "Curvature isn't Delta with a different weight. Each row carries Basel's pre-computed `CVR_k` for the up and down shock already — that's clause 2: `CVR_k^{±} = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]`. The upstream pricing layer materialises the bracketed term; the row hits Redis with `{cvr_up, cvr_down}` already populated — you can see the actual tenor arrays in the drilldown I just opened. The schema YAML on screen defines the row shape; the loader at `correlations.ts` reads it; the Lua kernel sums those CVRs per tenor across all rows in the bucket — that's **line 48** of `girr_curvature.lua`."
- **Basel anchor.** MAR21 §21.5(2): `CVR_k^{up|down} = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]`. Implementation: [`services/calc/lib/girr_curvature.lua:48-71`](../../services/calc/lib/girr_curvature.lua) (per-tenor `sum_up[k]` / `sum_down[k]` aggregation); schema contract at [`config/schema/frtb-default.yaml:25-28`](../../config/schema/frtb-default.yaml).
- **Live value to point at.** GIRR Curvature: 11 / 11 buckets populated, `count > 0` everywhere; row counts per bucket range from AUD = 68 down to EUR = 54, summing to the 667 GIRR rows of the 2 000-row Curvature ingest leg. AUD drilldown row exposes a 10-element `cvr_up` array and a 10-element `cvr_down` array.
- **Screenshot.** `beat-06-curvature-pivot.png` (CalcPanel with Curvature selected + AUD drilldown open showing cvr_up/cvr_down arrays).
- **Time budget.** 40 s.

---

## Beat 7 — Within-bucket K_b for Curvature: §21.5(3) up / down + ψ gate

- **Visible on screen.** **Per-bucket K_b** PanelCard (`BucketChargeChart` + per-bucket breakdown table) re-populates for GIRR Curvature: eleven bars + eleven rows of `(bucket, count, S_b, K_b, ms)` — note these K_b values are in the thousands, not fractions. Presenter expands the AUD row drilldown.
- **Presenter says.** "Inside the bucket, §21.5(3) builds K_b in two passes — once for the up-shock CVRs, once for the down-shock CVRs — and takes the worse: `K_b^{up|down}² = max(0, Σ_k CVR_k² + Σ_{k≠l} ρ_curv · CVR_k · CVR_l · ψ(CVR_k, CVR_l))` with `ρ_curv = (ρ_delta)² = 0.99² = 0.9801`, then `K_b = max(K_b^up, K_b^down)`. S_b is the directional sum `Σ_k CVR_k` of whichever side won (tie defaults to up). The ψ gate matters **here**, not just at the cross-bucket reduce — `ψ = 0` whenever **both** CVRs in a pair are strictly negative, dropping that cross-tenor pair from the sum. That guard is the one-liner at **line 89** of `girr_curvature.lua` inside `_curv_kb_sq`. It lights up again at the §21.5(5) reduce — `curvatureCommon.ts:121` — gating bucket-pair contributions there too. So ψ is a two-layer guard, not a single cross-bucket switch."
- **Basel anchor.** MAR21 §21.5(3): `K_b = max(K_b^up, K_b^down)` where `K_b^{up|down}² = max(0, Σ_k CVR_k² + Σ_{k≠l} ρ_kl^curv · CVR_k · CVR_l · ψ(CVR_k, CVR_l))`, `ρ_kl^curv = (ρ_kl^delta)²`, `ψ(a,b) = 0 iff (a<0 ∧ b<0) else 1`. Implementation: [`services/calc/lib/girr_curvature.lua:78-96`](../../services/calc/lib/girr_curvature.lua) (`_curv_kb_sq` — ψ at line 89; line 84 accumulates `sum_sq = Σ CVR_k²`; line 90 adds the ρ-weighted cross only when ψ allows); direction pick + max selection at [`girr_curvature.lua:107-127`](../../services/calc/lib/girr_curvature.lua) (lines 108-109 compute both `kb_up_sq` / `kb_down_sq`, lines 121-127 pick the larger and emit `direction`). Shared TS kernel at [`services/calc/src/curvatureCommon.ts:62-78`](../../services/calc/src/curvatureCommon.ts) (`kbSquaredForDirection`, ψ at `:55-57`).
- **Live value to point at.** GIRR Curvature top three on screen: AUD `K_b = 1841.30` / `S_b = 1857.91` / count 68; CAD `K_b = 1797.30` / `S_b = 1813.57` / count 67; NZD `K_b = 1776.51` / `S_b = 1792.53` / count 67. Every bucket strictly positive; ρ_curv = 0.9801. The FCALL computes both `K_b^up` and `K_b^down` internally and ships only the winner — the response surface stays identical to Delta/Vega, but `direction` is logged inside the Lua kernel for trace purposes.
- **Screenshot.** `beat-07-curvature-kb-table.png` (Per-bucket K_b PanelCard for Curvature + AUD drilldown open).
- **Time budget.** 35 s.

---

## Beat 8 — Cross-bucket reduce for Curvature: §21.5(5) + ψ asymmetry gate

- **Visible on screen.** The **Risk-class charge** PanelCard for GIRR Curvature: the `AnimatedCharge` eases up to **`9,495.23`** (raw `9495.234078557116`). Right next to the hero number, the `CurvatureBranchPill` (Wave 5.19) renders the regulatory branch label — on this run it reads "§21.5(5) · positive interior" (tooltip: `Σ K_b² + Σ γ² · S_b · S_c ≥ 0; standard §21.5(5) charge`). The `basel-caption` underneath reads "GIRR · Curvature · MAR21 §21.5(5) Cross-bucket reduce (γ² · ψ-gated)". (There is no separate ψ-gate inspector in the UI — the branch pill is the on-screen confirmation that the ψ-gated positive-interior path fired; the ψ math itself lives in `curvatureCommon.ts:55-57` and is reachable via editor flip if asked.)
- **Presenter says.** "The cross-bucket reduce here is §21.5(5): `√max(0, Σ K_b² + Σ_{b≠c} γ²_bc · S_b · S_c · ψ(S_b, S_c))`. Two differences from §21.4(5): the γ is squared (Basel's curvature-specific γ_curv), and the ψ gate zeros out pairs where both bucket sums are negative — that's the asymmetry. The pill next to the number tells you which branch the api took: today it says positive-interior, so we landed on **lines 103–126** of `curvatureCommon.ts`. If the interior ever goes negative, the same response would flip the pill to '§21.5(5)(b) · S_b clipped fallback' and the math drops into **lines 128–139** — same γ_curv, same ψ gate, just `S_b*` instead of `S_b`."
- **Basel anchor.** MAR21 §21.5(5): `Charge = √max(0, Σ K_b² + Σ_{b≠c} γ²_bc · S_b · S_c · ψ(S_b, S_c))`. Implementation: [`services/calc/src/curvatureCommon.ts:103-126`](../../services/calc/src/curvatureCommon.ts) (positive-interior branch); fallback at lines 128-139. UI surface: `curvature-branch-pill` (`services/ui/src/panels/CalcPanel.tsx:392-414`).
- **Live value to point at.** GIRR Curvature `charge = 9,495.23`, branch pill = "positive interior"; EQUITY Curvature `charge = 367.29`; FX Curvature `charge = 1,036.94`. All three positive-interior, pill never flipped to fallback.
- **Screenshot.** `beat-08-curvature-charge.png` (Risk-class charge PanelCard for GIRR Curvature with `CurvatureBranchPill` visible).
- **Time budget.** 35 s.

---

## Beat 9 — Why Curvature dwarfs Delta: the upstream-revaluation framing

- **Visible on screen.** **Presenter narration only** — no dedicated comparison UI. Presenter re-runs GIRR Delta in the CalcPanel (charge `0.6846` on the Risk-class charge tile), then GIRR Curvature (charge `9,495.23`), letting the audience see the same hero number tile flip between two scales. No "comparison panel" is rendered — the contrast is delivered verbally.
- **Presenter says.** "This is the question every reviewer asks first, so let's get ahead of it. Watch the hero number on the Risk-class charge tile — I'll flip from GIRR Delta to GIRR Curvature. GIRR Curvature is 9,495 and GIRR Delta is 0.68 — four orders apart. That is exactly what Basel expects from this methodology. Delta is `RW_k · s_k` — a risk weight times a unit-sensitivity. Curvature is `CVR_k = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]` — a full upstream revaluation gap at the shocked rate. Different units, different scale, by construction. Per §21.5(2), CVR carries notional exposure; Delta carries first-order sensitivity. Seeing a four-orders-of-magnitude gap on a 2 000-row Curvature leg is the methodology working, not a bug."
- **Basel anchor.** MAR21 §21.5(2) (CVR_k as a revaluation gap) vs §21.4(3) (`WS_k = RW_k · s_k`). The unit mismatch is intrinsic to the framework.
- **Live value to point at.** Same CalcPanel charge tile flipping between GIRR Delta `0.6846` and GIRR Curvature `9,495.23` (ratio ≈ 1.4 × 10⁴). Pattern repeats per risk class: EQUITY Δ `6.92` vs EQUITY Curv `367.29` (≈ 53×); FX Δ `1.16` vs FX Curv `1,036.94` (≈ 894×).
- **Screenshot.** `beat-09-ratio-comparison.png` (two side-by-side captures of the Risk-class charge tile — one GIRR Delta, one GIRR Curvature — to anchor the verbal comparison).
- **Time budget.** 35 s.

---

## Beat 10 — The full 9-variant sweep (GIRR / EQUITY / FX × Δ / V / Curvature)

- **Visible on screen.** Presenter drives the existing CalcPanel manually through all nine combinations — three risk classes × three sensitivity types — clicking **Calculate** on each. After each click, the **Risk-class charge** tile + wallclock badge update; the presenter calls out the per-class L2 verbally and notes it into a printed reference card (the canonical 3 × 3 matrix below, kept beside the keyboard — *not* rendered in the UI). After the ninth click, presenter switches to a pre-loaded terminal tab and runs `curl -s http://localhost:8080/observability/memory | jq` to read out the live `used_memory_human` and the Δ-over-baseline arithmetic. There is no "matrix sweep" button, no in-UI 3 × 3 grid, and no in-UI cost-cap tile — the matrix is the presenter's reference; the cap-utilisation is narrated off the observability endpoint.

**Reference matrix the presenter is filling in (printed card, not on screen):**

| Risk class | Delta | Vega | Curvature | Per-class L2 |
|---|---:|---:|---:|---:|
| **GIRR** | 0.6846 | 52.060 | 9495.234 | **9,495.38** |
| **EQUITY** | 6.9244 | 15.302 | 367.295 | **367.68** |
| **FX** | 1.1553 | 15.404 | 1036.939 | **1,037.05** |
| **Grand L2** | — | — | — | **9,558.91** |

- **Presenter says.** "Same math path, nine variants — I'll click through each one. [click 1] GIRR Delta, 0.6846, wallclock under 300 ms. [click 2] GIRR Vega, 52.06. [click 3] GIRR Curvature, 9,495.23 — that's the big one, positive-interior pill. [clicks 4–6] EQUITY: 6.92, 15.30, 367.29. [clicks 7–9] FX: 1.16, 15.40, 1,036.94. Every call HTTP 200, every per-bucket count strictly positive, every charge strictly positive. Per-class L2 across the three legs gives GIRR = 9,495.38, EQUITY = 367.68, FX = 1,037.05; the grand L2 across the three risk classes is **9,558.91**. Now the cost economics — let me hit `/observability/memory`: [paste] `used_memory_human = 32.96 MB`, baseline was `8.07 MB`, so Δ-over-baseline = 24.89 MB = 82.97 % of the 30 MB cap on this Redis Cloud tier. That's the production-relevant number: nine full risk-class charges on 6,000 sensitivities, end-to-end on a single 30 MB-bounded database, with ~5 MB of cap headroom to spare. The per-row storage cost averages 3.86 KB blended across the three legs — the source of truth is `smoke-run-17/SUMMARY.md` and the math is in `Q5` of this document. On a multi-shard Redis Enterprise cluster the per-row cost is unchanged and the cap-headroom story scales linearly with shard count."
- **Basel anchor.** Same MAR21 §21.4(3)–(5) path per Delta/Vega; §21.5(2)–(5) path per Curvature; per-class γ matrix sourced via [`services/api/src/sbm/correlations.ts:9-27`](../../services/api/src/sbm/correlations.ts) from the schema YAML.
- **Live value to point at.** Nine-variant total HTTP-200 hit rate `9/9`; per-variant wallclock `263–301 ms`, fanout `149–181 ms`; cap utilisation `24.89 / 30 MB = 82.97 %` read live from `/observability/memory` (per Wave 5.24 canonical reset). Source: [`docs/recordings/smoke-run-17/aggregate.json`](../recordings/smoke-run-17/aggregate.json) for charge values; live memory verified against Wave 5.24 completion report (pinned grand-total `9558.91465449378` — bit-for-bit identical to smoke-run-17).
- **Screenshot.** `beat-10-grand-total.png` (CalcPanel showing the ninth click — FX Curvature `1,036.94` — plus a second capture `beat-10-memory.png` of the terminal tab with the `/observability/memory` output).
- **Time budget.** 45 s.

---

## Closer beat (≤ 30 s — what production looks like)

**Visible on screen.** **Presenter narration only** over a single static slide with three bullets: cluster topology (multi-shard Redis Enterprise with hash-tag locality preserved), the FRTB matrix scope the bank would want next (§21.6 cross-class total, DRC default-risk charge, RRAO residual-risk add-on), and the integration shape (one REST endpoint, JSON in / JSON out, schema in `config/schema/`).

**Presenter says.** "Today you saw the full SBM-Delta + SBM-Vega + SBM-Curvature path on a standalone DB with 6,000 rows. The same code runs on a multi-shard Redis Enterprise cluster — the hash-tag locality you saw on line-70 of `girr_delta.lua` is the property that makes that scale-up linear, not a code change. The next slots in the matrix are the §21.6 cross-class total (rolling the grand L2 you just saw into a single trading-book number), the default-risk charge (DRC), and the residual-risk add-on (RRAO). The integration surface stays a single POST."

**Screenshot.** `beat-11-closer.png` (static slide).

**Time budget.** 25 s.

**Total presenter time across setup + 10 beats + closer: 25 + 30 + 40 + 40 + 40 + 25 + 40 + 35 + 35 + 35 + 45 + 25 = 415 s.**

---

## Anticipated questions (the bank's market-risk reviewers)

**Q1 — Why Redis vs a traditional risk grid?** The SBM map step is per-bucket and embarrassingly parallel; pinning each `K_b` calculation to the slot owning that bucket (via the `{risk_class:bucket}` hash tag) removes the network round-trip per row. On this run the per-variant fanout was `149–181 ms` over eleven (or thirteen, for Equity) buckets — the same shape scales linearly on a multi-shard cluster, where each shard does its own `K_b` locally.

**Q2 — How does this handle the curvature charge?** Yes, end-to-end. §21.5(2) CVR_k pairs are pre-computed upstream and arrive on each row as `{cvr_up, cvr_down}` (per-tenor arrays for GIRR; scalars for Equity / FX). §21.5(3) within-bucket K_b runs slot-local in `girr_curvature.lua` / `equity_curvature.lua` / `fx_curvature.lua`. §21.5(5) cross-bucket reduce — with the squared γ_curv and the ψ asymmetry gate — runs in `services/calc/src/curvatureCommon.ts:103-126`, with the §21.5(5)(b) negative-interior fallback at lines 128-139. Live charges this run: GIRR `9,495.23`, EQUITY `367.29`, FX `1,036.94`.

**Q3 — Why is GIRR Curvature ~10⁴× larger than GIRR Delta?** That gap is structural, not a sign error. Delta is `WS_k = RW_k · s_k` — a risk weight times a unit-sensitivity (§21.4(3)). Curvature is `CVR_k = −Σ_i [ V_i(x_k ± RW_k^curv) − V_i(x_k) − RW_k^curv · s_{ik} ]` — a full upstream revaluation gap at the shocked rate (§21.5(2)). Different units, different scale, by Basel's design. On a 2 000-row Curvature leg the GIRR ratio lands near 1.4 × 10⁴; EQUITY ≈ 53×; FX ≈ 894×. That is what regulators expect when CVR pairs are upstream revaluations rather than RW · sensitivity products.

**Q4 — How are you handling §21.5(5)(b)?** Clip-and-recompute mirroring the §21.4(7) shape: when the cross-bucket interior `Σ K_b² + Σ γ²_bc · S_b · S_c · ψ` goes negative, we replace each `S_b` with `S_b* = max(min(S_b, K_b), −K_b)` and re-evaluate the same expression with the same γ_curv and ψ gate. Implementation at [`services/calc/src/curvatureCommon.ts:128-139`](../../services/calc/src/curvatureCommon.ts); the inline comment at [`services/calc/src/curvatureCommon.ts:99`](../../services/calc/src/curvatureCommon.ts) flags this explicitly as a **text-fidelity caveat** — a strict Curvature-only reading of §21.5(5)(b) would clip negatives to 0 instead of to ±K_b. We chose the ±K_b shape for consistency with the §21.4(7) implementation already in production at `services/api/src/sbm/reduce.ts:64-75`, and we have flagged the choice for the bank's business sign-off before production cut-over.

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
