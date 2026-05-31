# MAR21 §21.5 Curvature charge — MVP scope

**Audience**: same coordinator/implementor team that delivered smoke-run-15 (Wave 5.15s, 2 000 rows, GIRR + Equity + FX Delta + Vega, 7.27 MB Δ-over-baseline, 6/6 calc variants HTTP 200).
**Status of this document**: pre-implementation scope, written before any source is touched. Reviewer signs off the schema-choice question and the cost-cap trade-off in section 7 before Wave 5.16a is delegated.
**Basel anchor**: MAR21 §21.5 "Sensitivities-based method: curvature risk". Clauses (1)–(5)(b) referenced inline.

---

## 1. What Curvature is

The Curvature charge under MAR21 §21.5 captures the **second-order PnL risk** that the Delta-only charge cannot see — the convexity in option-like instruments where a linear approximation under-states risk for large shocks. Per MAR21 §21.5(2), every Curvature risk factor `k` is shocked **twice** (an up-shock by the regulatory curvature weight `RW_k^{curv}` and a matching down-shock), and the linear (Delta) component is subtracted from each shocked-portfolio revaluation, leaving the pure curvature contributions `CVR_k^+` and `CVR_k^-`. Per MAR21 §21.5(3), within each bucket the up-side and down-side aggregates `K_b^+` and `K_b^-` are formed with the same ρ_kl correlation pattern Delta uses, and **the bucket-level K_b is the max of the two**. Per MAR21 §21.5(5), the risk-class Curvature charge then aggregates across buckets with a Curvature-specific γ_bc and an indicator ψ that zero-weights bucket-pairs whose `S_b` are both negative — i.e. the geometry is the Delta charge with three twists: (a) two-sided risk factors, (b) a `max(+, −)` selection per bucket before cross-bucket aggregation, and (c) a ψ-gated cross-bucket term.

## 2. Math reference (Unicode, with clause cites)

Per-risk-factor shocked aggregates — **MAR21 §21.5(2)**:

```
CVR_k⁺ = − Σ_i { V_i(x_k · (1 + RW_k^curv)) − V_i(x_k) − RW_k^curv · s_{i,k} }
CVR_k⁻ = − Σ_i { V_i(x_k · (1 − RW_k^curv)) − V_i(x_k) + RW_k^curv · s_{i,k} }
```
(`i` runs over instruments mapped to factor `k`; `s_{i,k}` is the Delta sensitivity of instrument `i` to factor `k`. The subtraction of `RW^curv · s` strips the linear/Delta component out of the shocked-PnL difference, leaving pure convexity.)

Per-bucket aggregation — **MAR21 §21.5(3)**:

```
K_b⁺ = √ max( 0 ,  Σ_k max(CVR_k⁺, 0)²
                  + Σ_{k≠l} ρ_kl · CVR_k⁺ · CVR_l⁺ · ψ(CVR_k⁺, CVR_l⁺) )
K_b⁻ = √ max( 0 ,  … same with CVR⁻ … )
K_b  = max(K_b⁺ , K_b⁻)
```
where `ψ(a, b) = 0 if a < 0 AND b < 0, else 1`. The bucket-level `S_b` carried into the cross-bucket step is the `Σ_k CVR_k^{sign}` for whichever sign won the max (record the winning sign per bucket).

Risk-class aggregation — **MAR21 §21.5(5)**:

```
Curvature_charge = √ max( 0 ,  Σ_b K_b²
                              + Σ_{b≠c} γ_bc · S_b · S_c · ψ(S_b, S_c) )
```

Negative-interior fallback — **MAR21 §21.5(5)(b)** (the analogue of §21.4(7) for Curvature): if the expression inside the outer √ is negative, recompute with `S_b*` chosen as the sign-aligned alternative from `{S_b⁺, S_b⁻}` such that the cross-bucket term is maximised under the ψ gate. (Detailed sign-selection algorithm is in §21.5(5)(b) — implementation will mirror the §21.4(7) clip-and-recompute pattern already in `services/api/src/sbm/reduce.ts:51-62`.)

## 3. Schema additions

### 3a. Row JSON shape

New `sensitivity_type` enum value: `"Curvature"` (joining `"Delta"` and `"Vega"`).

**Two candidate `risk_value` shapes — recommendation: shape A (pre-computed CVR pair).**

| Shape | `risk_value` payload | Math owner | Row size (GIRR, 10 tenors) | Compose with current code? |
|---|---|---|---|---|
| **A — pre-computed CVR** (recommended) | `{ cvr_up: number[T], cvr_down: number[T] }` — per-tenor `CVR_k⁺` and `CVR_k⁻` already shock-revalued and Delta-stripped upstream | upstream risk engine (HSBC sends them) | ~2× the Delta row payload | Yes — Lua does no revaluation; just bucket-aggregates two vectors, same SCAN+sum pattern as `girr_delta.lua` |
| B — shocked PnLs + Delta | `{ v_up: number[T], v_down: number[T], v_base: number, delta: number[T] }` plus row-level `RW_curv` | Lua, on every call (subtracts linear term per row) | ~3.5× the Delta row payload (4 number arrays vs 1) | No — Lua needs to apply MAR21 §21.5(2), tracking per-instrument `V_i` independently; this is a real revaluation engine and not in scope for a 2026-Q2 MVP |

**Rationale for A**: MAR21 §21.5(2)'s subtraction term is bank-internal — the CVR values that arrive at the regulatory engine are the pure-curvature numbers the bank's pricing system already produced. Asking Lua to redo it would (i) force a per-row Delta sensitivity field into every Curvature row, (ii) duplicate revaluation logic already inside the bank, and (iii) violate the "calc layer is aggregation, not pricing" boundary that the MVP is built on. Shape A keeps the Curvature Lua function structurally identical to `girr_delta.lua` — only the field name changes from `risk_value` to `{cvr_up, cvr_down}`.

### 3b. `config/schema/frtb-default.yaml` additions

Three new sections, mirroring the existing `*_weights` / `*_rho` / `*_gamma` triple:

- `risk_weights.<class>_curvature_weights`: per-bucket (or per-tenor for GIRR) curvature shock magnitudes. Per MAR21 §21.5(4), Curvature uses the **highest of the Delta weights** for each risk factor — schema can either inline this or compute it from the existing Delta weights at load time. Recommend inlining for transparency.
- `correlations.<class>_curvature_rho_kl`: intra-bucket Curvature correlation. Per MAR21 §21.5(3), `ρ_kl^{curv} = ρ_kl^{delta}²` for most classes — but encode independently so the demo can show both.
- `correlations.<class>_curvature_gamma_bc`: cross-bucket Curvature correlation, similarly squared from the Delta γ.

Each `risk_classes.<CLASS>` entry gains three new refs: `curvature_risk_weights_ref`, `intra_bucket_curvature_correlation_ref`, `cross_bucket_curvature_correlation_ref`.

## 4. Code plan (file-by-file)

| File | Action | Notes |
|---|---|---|
| `services/calc/lib/girr_curvature.lua` (new) | Add `frtb.sbm_curvature_bucket` Lua function (GIRR variant) | SCAN `sens:{GIRR:<bucket>}:*`, filter `sensitivity_type=="Curvature"`, read `cvr_up[k]` / `cvr_down[k]`, accumulate two parallel `sum_ws²` and `cross` totals, return `{ K_b, K_b_plus, K_b_minus, S_b, S_b_plus, S_b_minus, sign, count, ms }`. ~110 LoC. |
| `services/calc/lib/equity_curvature.lua` (new) | Equity variant of the above | Per-bucket scalar weight (same as `equity_delta.lua`), scalar `cvr_up`/`cvr_down` per row. ~95 LoC. |
| `services/calc/lib/fx_curvature.lua` (new) | FX variant | Single weight constant, scalar `cvr_up`/`cvr_down` per row. ~90 LoC. |
| `services/calc/src/girrCurvatureReference.ts` (new) | TS oracle for the GIRR Curvature K_b math | Mirrors §21.5(2)–(3) line-for-line; consumed by integration tests. ~110 LoC. |
| `services/calc/src/equityCurvatureReference.ts` (new) | Equity TS oracle | ~85 LoC. |
| `services/calc/src/fxCurvatureReference.ts` (new) | FX TS oracle | ~85 LoC. |
| `services/calc/src/loadFrtbLibrary.ts` (modify) | Register 3 new snippets via the existing `FrtbLibrarySnippet` interface | Single export array addition; alphabetical sort already handled by the loader. ≤ 10 LoC delta. |
| `services/calc/src/{girr,equity,fx}CurvatureSnippet.ts` (new, x3) | Lua-source-to-snippet glue + schema-literal substitution | Mirrors the existing `*Snippet.ts` siblings (substitute `__*_CURVATURE_WEIGHTS__` etc.). ~50 LoC each. |
| `services/api/src/sbm/reduce.ts` (modify) | Add `reduceCurvatureCharge(per, corr)` exported alongside `reduceRiskClassCharge` | New function handles the ψ indicator on the cross term and the §21.5(5)(b) sign-flip fallback. ~70 LoC delta. |
| `services/api/src/sbm/correlations.ts` (modify) | Build a separate `Record<string, CorrelationSpec>` for Curvature γ | Mirrors `buildCrossBucketCorrelations`; reads `cross_bucket_curvature_correlation_ref`. ~25 LoC delta. |
| `services/api/src/routes/calc.ts` (modify) | Extend `ALLOWED_LEG` to include `"curvature"`; add `curvature: "<func>_curvature"` to `FUNC_BY_RISK_CLASS`; route to `reduceCurvatureCharge` when leg is curvature | ~30 LoC delta. |
| `services/generator/src/row-generator.ts` (modify) | Add `"Curvature"` to `SENSITIVITY_TYPES`; emit `{cvr_up, cvr_down}` payload for Curvature rows (per-risk-class shape) | ~40 LoC delta. |
| `config/schema/frtb-default.yaml` (modify) | Add `*_curvature_weights`, `*_curvature_rho_kl`, `*_curvature_gamma_bc` entries; wire refs into each `risk_classes.<CLASS>` | ~60 lines added (3 weights × 3 classes + 3 ρ + 3 γ + refs). |
| `services/calc/test/*.spec.ts` (extend, no new files) | Add Curvature cross-check cases to existing oracle test files | Mirror the Delta/Vega oracle-vs-FCALL pattern. ~50 LoC per file. |

**Total**: 9 new files (3 Lua + 3 TS oracles + 3 TS snippet glues), 6 modified files, ~1 100 LoC across the wave family.

## 5. Wave breakdown (5.16a → 5.16e)

| # | Title | Scope (1 line) | Files touched (≤ 4) | Definition of Done |
|---|---|---|---|---|
| **5.16a** | Math + TS oracles | Write the 3 TS reference oracles (`{girr,equity,fx}CurvatureReference.ts`) implementing §21.5(2)–(3) end-to-end against in-memory row arrays; no Redis | `services/calc/src/{girr,equity,fx}CurvatureReference.ts` (3 new) + 1 unit-test file extension | All 3 oracles pass hand-computed fixtures for `K_b⁺`, `K_b⁻`, `K_b = max(…)`, and `S_b` sign-selection; unit tests green. |
| **5.16b** | Lua FCALL functions + bucket K_b | Author the 3 Lua functions + snippet glue + loader registration | `services/calc/lib/{girr,equity,fx}_curvature.lua` (3 new) + `services/calc/src/loadFrtbLibrary.ts` | `FUNCTION LOAD` succeeds; per-bucket `FCALL` returns `{K_b, S_b, sign, count, ms}` matching the Wave 5.16a oracle on a 50-row hand-fixture for each class. |
| **5.16c** | Reduce path + API route | Add `reduceCurvatureCharge` (with §21.5(5)(b) fallback) and extend the calc route to accept `leg=curvature` | `services/api/src/sbm/reduce.ts` + `services/api/src/sbm/correlations.ts` + `services/api/src/routes/calc.ts` | `POST /calc/sbm` with `{risk_class:"GIRR", sensitivity_type:"curvature"}` returns HTTP 200, strictly positive `charge`, per-bucket array with `sign ∈ {+, −}` populated; integration test pins against TS oracle. |
| **5.16d** | Generator + schema + e2e | Add Curvature rows to the generator; add curvature_* sections to the schema; run an e2e against a fresh standalone Redis Cloud DB | `services/generator/src/row-generator.ts` + `config/schema/frtb-default.yaml` + e2e test harness | `npm run smoke:curvature` ingests 500–2000 Curvature rows alongside the existing Delta/Vega mix; all 9 calc variants (3 classes × 3 legs) return HTTP 200 with positive charges; FT.INFO density still 100 %. |
| **5.16e** | MVP run + traceability pack update | Smoke-run-16: full 9-variant calc matrix on Redis Cloud; extend `mar21-traceability.md` with §21.5 clauses (2)/(3)/(5)/(5)(b); refresh `exec-summary.md` Curvature row | `docs/demo/mar21-traceability.md` + `docs/demo/exec-summary.md` + `docs/recordings/smoke-run-16/SUMMARY.md` (new) + `docs/recordings/smoke-run-16/calc-*-curvature.json` (new) | smoke-run-16 status 🟢 GREEN; clause-to-source mapping for §21.5(2), (3), (5), (5)(b) present; exec-summary headline numbers updated; cost-cap evidence reflects the agreed cap from §6 below. |

## 6. Cost estimate (marginal memory cost)

**Per-row Curvature payload** vs current Delta/Vega (run-15 measured = 4.46 KB/row of stored RedisJSON, including ~2.2 KB of dimensional metadata that every row carries regardless of leg):

| Class | Delta row payload | Curvature row payload | Estimated Curvature row size |
|---|---|---|---|
| GIRR | 10 floats in `risk_value` (~80 B) | 2 × 10 floats in `{cvr_up, cvr_down}` (~180 B + JSON key overhead ≈ 220 B) | **~6.8 KB** (2.2 KB metadata + 220 B payload + ~4.4 KB RJSON path/index overhead) |
| Equity | 1 scalar (~10 B) | 2 scalars (~30 B + JSON keys ≈ 50 B) | **~4.6 KB** (essentially Delta + 150 B) |
| FX | 1 scalar (~10 B) | 2 scalars (~50 B) | **~4.6 KB** |

**Headline estimate**: weighted average ~5.3 KB per Curvature row across a 1/1/1 mix; rounding up to **~7 KB** to absorb RedisJSON path-table growth + RediSearch index entries for the new `sensitivity_type=Curvature` tag value (the index is currently sized for 3 cardinality on this tag, so no rebuild — but each indexed doc adds ~150 B to the postings list).

**Projection at three dataset sizes** (Δ = Curvature-only contribution above the current 7.27 MB baseline):

| Curvature rows | Curvature Δ | New total Δ-over-baseline | vs current 9 MB cap |
|---|---|---|---|
| 2 000 (parity with Delta+Vega) | ~14.0 MB | **~21.27 MB** | +12.27 MB over cap — **fails** |
| 1 000 | ~7.0 MB | **~14.27 MB** | +5.27 MB over cap — **fails** |
| 500 | ~3.5 MB | **~10.77 MB** | +1.77 MB over cap — **fails** |
| 250 | ~1.75 MB | **~9.02 MB** | +0.02 MB over cap — **borderline** |

**Trade-off — pick one before Wave 5.16d**:

1. **Raise the cap to 25 MB** and ingest 2 000 Curvature rows (parity). Headline: still 1.0 % of the 2.5 GB DB; preserves "live data" credibility. Cost: one-line change in the smoke harness cap-check + a refreshed cap rationale in `exec-summary.md`.
2. **Hold the cap at 9 MB**, shrink Curvature to 250 rows. Headline: "Curvature lives on Redis, but the demo dataset is intentionally small to fit the agreed budget." Cost: weaker live-evidence story (small `count` per bucket means several buckets may be empty).
3. **Hold the cap, halve Delta+Vega to 1 000 rows, add 1 000 Curvature** → projected ~10.6 MB. Still ~1.6 MB over the 9 MB cap; requires raising to ~12 MB anyway. Not recommended.

**Recommendation**: option 1 (raise cap to 25 MB). The 9 MB cap was set to demonstrate "FRTB SBM fits in a small Redis"; 25 MB at the same 2.5 GB DB is 1.0 % — the same story, larger dataset. Confirm with reviewer in §7.

## 7. Risks + open questions

1. **Schema choice (shape A vs B)** — recommendation in §3 is shape A (pre-computed CVR pair). Confirm before Wave 5.16a — the oracle math is identical either way, but shape B forces a row-level Delta sensitivity field that doubles row size again.
2. **Cost-cap trade-off** — §6 options 1/2/3. Default recommendation: raise to 25 MB (option 1).
3. **Curvature ρ_kl and γ_bc source** — MAR21 §21.5(3) prescribes `ρ_kl^{curv} = ρ_kl^{delta}²` (and similarly γ²). For the MVP, encode them as independent schema entries (so the YAML is auditable) or auto-derive at load? Recommendation: encode independently for transparency.
4. **§21.5(5)(b) sign-flip fallback** — needed for the MVP, or stub it as "non-positive interior triggers `charge = max(charge_signs)`"? Recommendation: implement faithfully (mirrors the §21.4(7) work already in `reduce.ts:51-62`; not a large delta).
5. **Multi-instrument mapping** — MAR21 §21.5(2) sums `V_i` over instruments mapped to risk factor `k`. Under shape A this collapses into the ingest layer (rows arrive pre-aggregated per factor) — confirm this matches HSBC's expected feed shape.

## 8. Out of scope for the Curvature MVP

- **Recursive curvature** (re-shocking on top of an already-shocked baseline) — MAR21 §21.5 does not prescribe it; banks that produce it ship it as a separate sensitivity stream.
- **MAR21 §21.5(3) high/low correlation alternative** — the prescribed `ρ_kl^{curv}` is used; the high (× 1.25) / low (× 0.75) scenario sweep that §21.6 references for total capital is a separate aggregation layer.
- **Cross-currency Curvature edge cases** for GIRR — same single-currency-bucket simplification as the Delta path in run-15; multi-currency basis correlation γ_cur is not added in this scope.
- **CSR / Commodity Curvature** — the MVP family stays on the GIRR / Equity / FX trio that Delta + Vega already cover. CSR and Commodity Curvature reuse the same Lua/TS template but are not delivered in Wave 5.16.
- **Curvature shock-size schema versioning** — `curvature_weights` ship as a single representative magnitude per class for the MVP; the "swap-on-real-HSBC-schema" path (Wave 2 lock) carries over unchanged.
- **Total-capital aggregation** — Delta + Vega + Curvature → single per-class capital number per MAR21 §21.6 is **not** in Wave 5.16; it is a separate Wave 5.17 candidate.
