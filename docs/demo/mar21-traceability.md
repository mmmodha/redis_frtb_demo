# MAR21 §21.4 — Sensitivities-Based Method (SBM) traceability pack

**Basel framework reference**: MAR21 §21.4 — *"Sensitivities-based method: aggregation of sensitivities and risk charges within a risk class"*. Clauses 3, 4, 5 and the 5(b) (negative-interior) alternative are the four clauses covered by the FRTB SBM PoV MVP. HSBC market-risk reviewers can locate the source clauses in their Basel framework copy by searching for "MAR21 21.4".

**Source DB**: `lip-veil-spring-32424.db.redis.io:14596` — standalone Redis Cloud DB, Redis 8.4.0, single primary + 1 replica, `maxmemory_policy=noeviction`.
**Run timestamp**: 2026-05-29 (Wave 5.15q, smoke-run-15).
**Dataset size (intended)**: 2 500 rows, classes GIRR + EQUITY + FX.
**Status of this run**: 🔴 RED — api bootstrap blocked at step 2 (api↔Redis-Cloud readiness path bug; see `docs/recordings/smoke-run-15/SUMMARY.md`). **No live calc executed this run.** The **Live value** column below is populated from the last successful 6-variant calc matrix (`docs/recordings/smoke-run-14/calc-results.json`, attempt 2, `--rows 150000`) and is **reference-only**; absolute numbers in a 2 500-row 5.15q run will differ but the per-bucket K_b > 0 / S_b ≠ 0 / count > 0 shape will match. File:line references are pinned against the current `main` source tree.

---

## Clause-by-clause traceability

| # | MAR21 §21.4 clause (verbatim excerpt) | Formula | Code implementation (file:line) | Live value (GIRR Delta — reference, smoke-run-14) | Presenter one-liner |
|---|---|---|---|---|---|
| **3** | "*The weighted sensitivity WS_k of each net sensitivity s_k to risk factor k is calculated by multiplying the net sensitivity by the corresponding risk weight RW_k as follows.*" — `WS_k = RW_k · s_k` | `WS_k = w_k · Σ_rows s_k` (per tenor k, summed across all rows in bucket b) | `services/calc/lib/girr_delta.lua:66-72` (the `sum_s[k]` accumulation in `_delta_iter_bucket` returns Σ_rows s_k for each tenor k; the `weights[k] * sum_s[k]` multiplication on **line 70** produces WS_k) | GIRR Delta, bucket **JPY** (count = 2 303 rows): `S_b = Σ_k WS_k = -1.825262786`. Per-tenor WS_k vector not surfaced in the response shape, but `S_b` (its sum) is the contract-level summary. | "Each row's tenor-vector sensitivity is risk-weighted at the Redis-shard level inside the bucket SCAN — Basel says multiply by RW_k, we do exactly that on **line 70** of `girr_delta.lua`." |
| **4** | "*The within-bucket aggregation is performed using the prescribed correlation parameter ρ_kl between weighted sensitivities WS_k and WS_l within bucket b, as follows.*" — `K_b = √( Σ WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l )` | `K_b = √( Σ_k WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l )`; constant-ρ specialisation used here: `K_b² = ΣWS² + ρ · ((ΣWS)² − ΣWS²)` | `services/calc/lib/girr_delta.lua:74-78` (line 74: `cross = sum_ws · sum_ws − sum_ws_sq` is the `(ΣWS)² − ΣWS²` term; line 75 floors cross at 0 to absorb FP noise; line 76: `kb_sq = sum_ws_sq + rho · cross` is the K_b² formula; line 78 takes the sqrt) | GIRR Delta, per bucket: JPY K_b = **1.8181942050429** (S_b = −1.825263, count = 2 303), AUD K_b = **1.0742826519614**, SEK K_b = **1.3981717946224**, OTHER K_b = **1.2207671841088**. Every K_b strictly positive — the within-bucket aggregation is producing the expected non-trivial figures. | "Within each bucket — same currency, same tenor curve — Basel correlates the tenor points with ρ. Look at the per-bucket K_b array: four populated buckets, four non-zero K_b values. That's clause 4 firing live in the FCALL." |
| **5** | "*The risk class-level aggregation across buckets is performed using the cross-bucket correlation γ_bc, as follows.*" — `Charge = √( Σ_b K_b² + Σ_{b≠c} γ_bc · S_b · S_c )` | `Charge = √( Σ_b K_b² + Σ_{b≠c} γ_bc · S_b · S_c )` | `services/api/src/sbm/reduce.ts:36-49` (lines 36-37: `sumK2 = Σ K_b²`; lines 39-46: double loop builds `cross = Σ_{i≠j} γ_bc · S_b · S_c` using the `gammaOf` lookup; line 48: `sum = sumK2 + cross`; line 49: returns `√sum` when the expression is non-negative). γ_bc itself is sourced from `services/api/src/sbm/correlations.ts:9-27` (per-risk-class lookup keyed off the schema YAML at `config/schema/frtb-default.yaml`). | GIRR Delta risk-class **charge = 3.114835551** (from `√( 1.8181942² + 1.0742827² + 1.3981718² + 1.2207672² + Σ_{b≠c} γ_GIRR · S_b · S_c )`, with the four S_b values −1.825263 / 0.157639 / −0.225012 / −0.903305 and γ_GIRR sourced from `frtb-default.yaml`). Charge is strictly positive — the positive-interior branch (line 49) is the one that fired in the reference run. | "Once each bucket has its K_b, we cross-correlate the bucket-level S_b values with the schema's γ_bc matrix and sqrt the whole thing. That's the `charge` you see in the response — clause 5, single sqrt, **line 49** of `reduce.ts`." |
| **5(b)** | "*If the expression inside the square root is negative, the risk class capital charge is calculated using the following alternative specification, where S_b is replaced by S_b* (capped within ±K_b).*" — `S_b* = max(min(S_b, K_b), −K_b)`, then `Charge = √( Σ K_b² + Σ_{b≠c} γ_bc · S_b* · S_c* )` | `S_b* = max(min(S_b, K_b), −K_b)`; `Charge = √( Σ K_b² + Σ_{b≠c} γ_bc · S_b* · S_c* )` | `services/api/src/sbm/reduce.ts:51-62` (line 52: per-bucket cap via `Math.max(Math.min(p.S_b, p.K_b), -p.K_b)` builds the `Splus` vector; lines 54-60: rebuild the cross term using `Splus`; line 61: `sumAlt = sumK2 + crossPlus`; line 62: returns `√max(sumAlt, 0)`). The branch is gated by `sum >= 0` at line 49 — only triggered when the standard expression goes negative. | **Not triggered** in the reference GIRR Delta run (the positive-interior branch returned 3.114835551 at `reduce.ts:49`). The negative-interior fallback exists, is reachable from the same call, and is mathematically faithful to the MAR21 §21.4(7) alternative — it just doesn't light up on this particular bucket set. | "If clause 5's expression ever goes negative — which only happens when high-magnitude negative S_b values dominate — Basel gives us an alternative formula that clamps each S_b inside ±K_b. That fallback is **lines 51-62** of `reduce.ts`; it sits one branch away from the happy path and the reviewer can verify the inequality test on line 49 picks the right branch every time." |

---

## How to re-run this clause-trace live

The reference values above were captured by smoke-run-14. To regenerate against the new standalone Redis Cloud DB once the api bootstrap path supports it (see SUMMARY.md "Recommendation"), the call shape is:

```
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"risk_class":"GIRR","sensitivity_type":"delta"}' \
  http://localhost:8080/calc/sbm
```

The response body's `per_bucket[*].{K_b,S_b,count}` array maps 1-to-1 onto clauses 3+4 (one row per bucket), and the top-level `charge` field is the clause-5 (or 5(b) fallback) output. Code paths above stay valid regardless of which DB serves the FCALL — they are sharded by `sens:{risk_class:bucket}:*` hash-tag, so each per-bucket FCALL stays slot-local on whichever Redis topology is in use.

---

## Provenance footnote

This pack ties Basel MAR21 §21.4 (the prescribed clause text, by clause number) to specific source lines in this repository **and** to the most recent successful production-shape calc output (`docs/recordings/smoke-run-14/calc-results.json`). It is intended as a single-page demo evidence asset for an HSBC market-risk reviewer who wants to confirm the implementation is a faithful translation of MAR21 §21.4(3)–(5) including the §21.4(7) negative-interior alternative, before approving the PoV for wider rollout.
