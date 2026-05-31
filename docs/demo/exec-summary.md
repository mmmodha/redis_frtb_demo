# FRTB SBM on Redis — HSBC PoV Executive Summary

**Audience**: Market-risk leadership. **Basis**: Live evidence from smoke-run-15 (Wave 5.15s, 2026-05-29T22:47Z, 2 000 rows on a standalone Redis Cloud DB).

## 1. Executive summary

This MVP demonstrates a Basel-faithful Sensitivities-Based Method (SBM) capital calculation under MAR21 §21.4 clauses 3, 4, 5, and the §21.4(7) negative-interior fallback, executed against a 2 000-row sensitivities dataset spanning GIRR, Equity, and FX (Delta and Vega). All six risk-class × leg variants returned HTTP 200 with strictly positive charges; the storage footprint is **7.27 MB Δ-over-baseline = 0.29 %** of a 2.5 GB Redis Cloud DB. Per-variant wallclock sits between **298 and 343 ms**.

## 2. Scope

| What this MVP demonstrates | What it does NOT yet cover |
|---|---|
| MAR21 §21.4(3) — risk-weighting of net sensitivities (WS_k = RW_k · s_k) | Curvature charge (separate Basel formula, not implemented) |
| MAR21 §21.4(4) — within-bucket aggregation under prescribed ρ_kl correlations producing K_b | Total-capital aggregation across Delta + Vega + Curvature for a single risk class |
| MAR21 §21.4(5) — cross-bucket aggregation under γ_bc correlations producing the risk-class charge | Cross-risk-class total capital (GIRR + Equity + FX + CSR + Commodity rollup) |
| MAR21 §21.4(7) — negative-interior alternative with S_b* = clip(S_b, ±K_b) (code-reachable, exercised on synthetic negatives) | GIRR cross-currency aggregation edge cases (single-currency basis correlation γ_cur) |
| Per-bucket evidence surfaced as `per_bucket[*].{K_b, S_b, count}` in the response, traceable line-by-line to Lua + TypeScript source | Production HA (multi-shard cluster, replica failover drills, observability stack) |
| Live calc matrix verified on standalone Redis Cloud DB; 100 % FT index density, zero `hash_indexing_failures` | Schema versioning + migration for weights/correlations updates between Basel revisions |

## 3. Headline numbers (smoke-run-15, live)

| Metric | Value |
|---|---|
| Database topology | Standalone Redis Cloud, 1 primary + 1 replica, 2.5 GB cap, `maxmemory_policy=noeviction` |
| Dataset | 2 000 rows; GIRR 667 / Equity 667 / FX 666; Delta + Vega legs |
| Memory footprint | Δ-over-baseline = **7.27 MB** = **0.29 %** of 2.5 GB DB capacity (peak = 7.27 MB; pre-teardown = 7.41 MB) |
| Index density | `FT.INFO idx:sens` → `num_docs=2000`, 100 % density, zero `hash_indexing_failures` |
| Calc matrix | **6 / 6** variants HTTP 200, all charges strictly positive, every populated bucket reports `count > 0` |
| GIRR Delta charge | **0.4658** (raw: 0.46577934393808174); fanout 130.034 ms; total 246.932 ms; 11 / 11 buckets populated |
| GIRR Vega charge | **35.5928** (raw: 35.59281830123902); 11 / 11 buckets populated |
| Equity Delta charge | **5.3650** (raw: 5.364975175194446); 13 / 13 buckets populated |
| Equity Vega charge | **12.0172** (raw: 12.017162949618458); 13 / 13 buckets populated |
| FX Delta charge | **0.6883** (raw: 0.6882912204934477); 11 / 11 buckets populated |
| FX Vega charge | **12.7275** (raw: 12.727534389007097); 11 / 11 buckets populated |
| Math sanity (MAR21 §21.4(5) bounds) | GIRR Delta charge **0.4658** ∈ **[max(K_b), Σ K_b] = [0.21, 1.56]** — inside the prescribed envelope |

## 4. Compliance evidence

The traceability pack at `docs/demo/mar21-traceability.md` maps **MAR21 §21.4 clauses 3, 4, 5, and the §21.4(7) negative-interior alternative** to specific source lines (Lua FCALL functions for clauses 3 + 4 at `services/calc/lib/girr_delta.lua:66-78`; TypeScript reducer for clauses 5 and §21.4(7) at `services/api/src/sbm/reduce.ts:36-62`) and to this run's live per-bucket K_b / S_b vector for all 11 GIRR Delta buckets. **Not covered in this MVP**: the curvature charge (separate MAR21 §21.4 sub-clause family), total capital aggregation across the Delta + Vega + Curvature triad, and the cross-risk-class total under MAR21 §21.4 / §21.6.

## 5. Architecture at a glance

- **Ingest**: sensitivities arrive as JSON rows; each row is keyed `sens:{risk_class:bucket}:<id>` so all rows for the same bucket land on the same Redis slot.
- **Storage**: rows are stored as RedisJSON documents; a `FT.SEARCH` index (`idx:sens`) provides bucket and risk-class fanout discovery.
- **Compute**: six Redis Lua functions (one per risk-class × leg) execute the §21.4(3) weighting and §21.4(4) within-bucket K_b aggregation server-side, slot-local, via `FCALL`.
- **API fanout**: the calc endpoint discovers populated buckets via `FT.SEARCH`, issues one `FCALL` per bucket in parallel, and reduces the per-bucket {K_b, S_b} pairs into the §21.4(5) charge (or §21.4(7) fallback when the interior is negative) in TypeScript.
- **Response**: a single JSON body returns `charge`, `per_bucket[*].{K_b, S_b, count}`, `total_ms`, and `fanout_ms` — the same shape the traceability pack pins line-by-line to clauses 3–5.
- **Topology in this run**: standalone Redis Cloud DB (1 primary + 1 replica) — slot-local fanout still applies and the path is unchanged in a sharded production deployment.

## 6. What "production" would add

- **Multi-shard cluster**: parallelism across risk classes and buckets; per-bucket FCALL stays slot-local, so latency scales sub-linearly with shard count.
- **Curvature charge**: implement the MAR21 §21.4 curvature sub-clauses (shocked-PnL aggregation) so a full risk-class capital number can be produced.
- **Cross-asset-class total capital**: roll Delta + Vega + Curvature per risk class, then aggregate across GIRR, Equity, FX, CSR, and Commodity per MAR21 §21.6.
- **HA + observability**: replica failover drills, metric / trace export, alerting on FCALL latency tail.
- **Schema versioning**: weights and correlations currently live in `config/schema/frtb-default.yaml`; production would version the schema, publish a migration path, and pin each calc result to a schema hash.

## 7. Appendix index

- [`docs/demo/mar21-traceability.md`](./mar21-traceability.md) — Basel clause → code mapping with live per-bucket values from this run (the four MAR21 §21.4 clauses called out above, all tied to specific source lines).
- [`docs/demo/storyboard.md`](./storyboard.md) — presenter walkthrough (delivered in parallel; see that file for the live-demo script).
- [`docs/recordings/smoke-run-15/SUMMARY.md`](../recordings/smoke-run-15/SUMMARY.md) — full per-step verdict table, memory timeline, calc matrix, and cost-cap evidence.
- [`docs/recordings/smoke-run-15/calc-girr-delta.json`](../recordings/smoke-run-15/calc-girr-delta.json), [`calc-girr-vega.json`](../recordings/smoke-run-15/calc-girr-vega.json), [`calc-equity-delta.json`](../recordings/smoke-run-15/calc-equity-delta.json), [`calc-equity-vega.json`](../recordings/smoke-run-15/calc-equity-vega.json), [`calc-fx-delta.json`](../recordings/smoke-run-15/calc-fx-delta.json), [`calc-fx-vega.json`](../recordings/smoke-run-15/calc-fx-vega.json) — raw response bodies for each of the six calc variants.
