# FRTB SBM on Redis — HSBC PoV Executive Summary

**Audience**: Market-risk leadership. **Basis**: Live evidence from smoke-run-17 (Wave 5.17d, 2026-06-01T17:10Z, 6,000 rows = 2,000 each Delta / Vega / Curvature on a standalone Redis Cloud DB).

## 1. Executive summary

This MVP demonstrates a Basel-faithful Sensitivities-Based Method (SBM) capital calculation under MAR21 §21.4 clauses 3, 4, 5 (with the §21.4(7) negative-interior fallback) and **MAR21 §21.5 Curvature clauses (2), (3), (5) (with the §21.5(5)(b) fallback)**, executed against a 6 000-row sensitivities dataset spanning GIRR, Equity, and FX across the full Delta / Vega / Curvature triad. All nine risk-class × leg variants returned HTTP 200 with strictly positive charges; the storage footprint is **23.99 MB Δ-over-baseline = 79.96 %** of a 30 MB Δ-cap on a 2.5 GB Redis Cloud DB. Per-variant wallclock sits between **263 and 301 ms**. The grand L2 across the three risk classes is **9,558.91** (reproduces bit-for-bit across two consecutive runs).

## 2. Scope

| What this MVP demonstrates | What it does NOT yet cover |
|---|---|
| MAR21 §21.4(3) — risk-weighting of net sensitivities (WS_k = RW_k · s_k) | MAR21 §21.6 — cross-risk-class total capital aggregation (rolling the 9,558.91 grand L2 into a single trading-book number, including CSR + Commodity) |
| MAR21 §21.4(4) — within-bucket aggregation under prescribed ρ_kl correlations producing K_b | Default Risk Charge (DRC) — non-securitisation / securitisation / CTP add-on under MAR22 |
| MAR21 §21.4(5) — cross-bucket aggregation under γ_bc correlations producing the risk-class charge | Residual Risk Add-On (RRAO) — gap / exotic / digital under MAR23 |
| MAR21 §21.4(7) — negative-interior alternative with S_b* = clip(S_b, ±K_b) (code-reachable, exercised on synthetic negatives) | Curvature × Vega-shock interaction (§21.5 Curvature is run against Delta risk factors here; the Vega-shock Curvature variant is out of scope) |
| **MAR21 §21.5(2)** — per-row Curvature CVR pairs `{cvr_up, cvr_down}` summed per-tenor into bucket aggregates | GIRR cross-currency aggregation edge cases (single-currency basis correlation γ_cur) |
| **MAR21 §21.5(3)** — within-bucket K_b^curv via per-tenor `max(CVR_k^up, CVR_k^down)` with non-negativity floor | Production HA (multi-shard cluster, replica failover drills, observability stack) |
| **MAR21 §21.5(5)** — cross-bucket reduce with squared γ_curv and the ψ asymmetry gate, plus the §21.5(5)(b) negative-interior fallback (clip-and-recompute, mirroring §21.4(7)) | Schema versioning + migration for weights / correlations / γ_curv updates between Basel revisions |
| Per-bucket evidence surfaced as `per_bucket[*].{K_b, S_b, count}` in the response for all 9 variants, traceable line-by-line to Lua + TypeScript source | Bootstrap wiring of the three `*_curvature` Redis Functions (named gap in `services/api/src/bootstrap.ts:buildFrtbSnippets`; loaded for this run via a docs-scoped helper — see SUMMARY.md) |
| Live calc matrix verified on standalone Redis Cloud DB; 100 % FT index density, zero `hash_indexing_failures` | Curvature library bootstrap parity with Delta / Vega (one-line bootstrap extension) |

## 3. Headline numbers (smoke-run-17, live)

| Metric | Value |
|---|---|
| Database topology | Standalone Redis Cloud, 1 primary + 1 replica, 2.5 GB cap, `maxmemory_policy=noeviction` |
| Dataset | 6,000 rows (2,000 Delta + 2,000 Vega + 2,000 Curvature); per leg GIRR 667 / Equity 667 / FX 666 |
| Memory footprint | Δ-over-baseline = **23.99 MB** = **79.96 %** of the 30 MB Δ-cap (peak P − B' = 25,158,032 B); blended per-row cost = **4.10 KB / row** |
| Index density | `FT.INFO idx:sens` → `num_docs=6000`, 100 % density, zero `hash_indexing_failures`; per `sensitivity_type` → Delta = 2,000, Vega = 2,000, Curvature = 2,000 |
| Calc matrix | **9 / 9** variants HTTP 200, all charges strictly positive, every populated bucket reports `count > 0` |

**3 × 3 charge matrix** (raw values from [`docs/recordings/smoke-run-17/aggregate.json`](../recordings/smoke-run-17/aggregate.json); displayed values rounded for readability):

| Risk class | Delta | Vega | Curvature | Per-class L2 (√(Δ² + V² + Curv²)) |
|---|---:|---:|---:|---:|
| **GIRR** | 0.6846 | 52.0601 | 9,495.2341 | **9,495.38** |
| **EQUITY** | 6.9244 | 15.3017 | 367.2947 | **367.68** |
| **FX** | 1.1553 | 15.4037 | 1,036.9389 | **1,037.05** |
| **Grand L2 across risk classes** | | | | **9,558.91** |

| Metric | Value |
|---|---|
| Math sanity (MAR21 §21.4(5) bounds, GIRR Delta) | GIRR Delta charge `0.6846` ∈ `[max(K_b), Σ K_b]` envelope — inside the prescribed bounds (NOK K_b = 0.2845 is the per-bucket max, Σ K_b = 2.184) |
| Math sanity (MAR21 §21.5(5) branch) | All three Curvature variants took the positive-interior branch at `curvatureCommon.ts:126`; §21.5(5)(b) fallback at lines 128–139 not exercised on this dataset |
| Per-variant wallclock | 263 – 301 ms `total_ms`; 149 – 181 ms `fanout_ms` |

**30 MB cap rationale.** Wave 5.16e1 pre-flight measured the per-Curvature-row cost at **9.47 KB / row** on this standalone DB (50-row probe, `Δ_data = 484,672 B`). Extrapolated to 2,000 Curvature rows × 3 legs that projects to ≈ 18.5 MB for Curvature plus ≈ 7.3 MB carry-over from the Delta + Vega smoke-run-15 footprint, landing in the low-20s MB range. The 30 MB cap is sized to give ≈ 25 % headroom over that projection; the live run came in at **23.99 MB = 79.96 %** of the cap, with **6.01 MB headroom** to spare.

**§21.5(5)(b) text-fidelity caveat.** The negative-interior Curvature fallback is implemented with a clip-to-±K_b shape (`S_b* = max(min(S_b, K_b), −K_b)` at [`services/calc/src/curvatureCommon.ts:128-139`](../../services/calc/src/curvatureCommon.ts)), mirroring the §21.4(7) Delta/Vega fallback at `services/api/src/sbm/reduce.ts:51-62`; a strict Curvature-only reading of §21.5(5)(b) would clip negatives to 0 instead. The choice is flagged inline at [`services/calc/src/curvatureCommon.ts:99`](../../services/calc/src/curvatureCommon.ts) and is queued for HSBC business sign-off before production cut-over.

## 4. Compliance evidence

The traceability pack at [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) maps **MAR21 §21.4 clauses 3, 4, 5 plus §21.4(7)** and **MAR21 §21.5 clauses (2), (3), (5) plus §21.5(5)(b)** to specific source lines. For §21.4: Lua FCALL kernels for clauses 3 + 4 at `services/calc/lib/girr_delta.lua:66-78`; TypeScript reducer for clause 5 and §21.4(7) at `services/api/src/sbm/reduce.ts:36-62`; live per-bucket K_b / S_b for all 11 GIRR Delta buckets. For **§21.5** (extended in Wave 5.16e2; the pack now carries 20 §21.5 citations across the (2) / (3) / (5) / (5)(b) clauses): Lua FCALL kernels for clauses (2) + (3) at `services/calc/lib/girr_curvature.lua:48-71` (with `equity_curvature.lua` and `fx_curvature.lua` for the scalar-shape variants); shared TypeScript kernel for clauses (5) + (5)(b) at `services/calc/src/curvatureCommon.ts:103-139`; live per-bucket K_b / S_b for all 11 GIRR Curvature buckets (AUD K_b = 1,841.30 top).

**Not covered by the traceability pack**: §21.6 cross-risk-class total capital, the DRC default-risk charge (MAR22), and the RRAO residual-risk add-on (MAR23).

## 5. Architecture at a glance

- **Ingest**: sensitivities arrive as JSON rows; each row is keyed `sens:{risk_class:bucket}:<id>` so all rows for the same bucket land on the same Redis slot. Curvature rows additionally carry the `{cvr_up, cvr_down}` shape A pair (GIRR: per-tenor arrays; Equity / FX: scalars) per the schema contract at `config/schema/frtb-default.yaml:25-28`.
- **Storage**: rows are stored as RedisJSON documents; a `FT.SEARCH` index (`idx:sens`) provides bucket and risk-class fanout discovery on `(risk_class, bucket, sensitivity_type)`.
- **Compute**: nine Redis Lua functions (one per risk-class × leg, covering Delta + Vega + Curvature) execute the §21.4(3) weighting and §21.4(4) within-bucket K_b aggregation (Delta / Vega) and the §21.5(2) per-tenor CVR aggregation and §21.5(3) within-bucket K_b^curv (Curvature) server-side, slot-local, via `FCALL`.
- **API fanout**: the calc endpoint discovers populated buckets via `FT.SEARCH`, issues one `FCALL` per bucket in parallel, and reduces the per-bucket {K_b, S_b} pairs into the §21.4(5) charge (or §21.4(7) fallback) for Delta / Vega, and into the §21.5(5) charge (or §21.5(5)(b) fallback) for Curvature in TypeScript.
- **Response**: a single JSON body returns `charge`, `per_bucket[*].{K_b, S_b, count}`, `total_ms`, and `fanout_ms` — the same shape the traceability pack pins line-by-line to clauses 3–5 for §21.4 and (2)–(5) for §21.5.
- **Topology in this run**: standalone Redis Cloud DB (1 primary + 1 replica) — slot-local fanout still applies and the path is unchanged in a sharded production deployment.

## 6. What "production" would add

- **Multi-shard cluster**: parallelism across risk classes and buckets; per-bucket FCALL stays slot-local, so latency scales sub-linearly with shard count.
- **MAR21 §21.6 cross-risk-class total capital**: roll the per-risk-class L2 (GIRR + Equity + FX in this MVP; CSR + Commodity in full scope) into the single regulator-facing trading-book SBM total.
- **Default Risk Charge (DRC) under MAR22**: non-securitisation / securitisation / CTP default-risk add-on — separate Lua kernels, same FCALL + reduce shape.
- **Residual Risk Add-On (RRAO) under MAR23**: gap / exotic / digital flat add-on, applied at the trading-book level alongside the SBM and DRC totals.
- **Bootstrap parity for Curvature**: extend `services/api/src/bootstrap.ts:buildFrtbSnippets` to wire the three `*_curvature` snippet builders into the production library load (today loaded for smoke-run-16 via a one-off docs-scoped helper; named gap in the smoke-run-16 SUMMARY).
- **HA + observability**: replica failover drills, metric / trace export, alerting on FCALL latency tail.
- **Schema versioning**: weights, correlations, and γ_curv currently live in `config/schema/frtb-default.yaml`; production would version the schema, publish a migration path, and pin each calc result to a schema hash.

## 7. Appendix index

- [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) — Basel clause → code mapping for both §21.4 and §21.5, with live per-bucket values from this run.
- [`docs/demo/storyboard.md`](./storyboard.md) — presenter walkthrough across the full 9-variant matrix (delivered in parallel; see that file for the live-demo script).
- [`docs/recordings/smoke-run-17/SUMMARY.md`](../recordings/smoke-run-17/SUMMARY.md) — full per-step verdict table, memory timeline, 9-variant calc matrix, cost-cap evidence, and the run-2 reproducibility table.
- [`docs/recordings/smoke-run-17/aggregate.json`](../recordings/smoke-run-17/aggregate.json) — rolled-up 3 × 3 charge matrix, per-class L2, and grand L2.
- [`docs/recordings/smoke-run-17/calc/`](../recordings/smoke-run-17/calc/) — nine raw calc response bodies: `calc-GIRR-Delta.json`, `calc-GIRR-Vega.json`, `calc-GIRR-Curvature.json`, `calc-EQUITY-Delta.json`, `calc-EQUITY-Vega.json`, `calc-EQUITY-Curvature.json`, `calc-FX-Delta.json`, `calc-FX-Vega.json`, `calc-FX-Curvature.json`.
- [`docs/recordings/smoke-run-16/preflight.md`](../recordings/smoke-run-16/preflight.md) — Wave 5.16e1 per-row cost measurement underpinning the 30 MB cap rationale (carried over; not re-measured in smoke-run-17).
