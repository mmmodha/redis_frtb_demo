# MAR21 §21.4 — Sensitivities-Based Method (SBM) traceability pack

**Basel framework reference**: MAR21 §21.4 — *"Sensitivities-based method: aggregation of sensitivities and risk charges within a risk class"*. Clauses 3, 4, 5 and the 5(b) (negative-interior) alternative are the four clauses covered by the FRTB SBM PoV MVP. HSBC market-risk reviewers can locate the source clauses in their Basel framework copy by searching for "MAR21 21.4".

**Source DB**: `lip-veil-spring-32424.db.redis.io:14596` — standalone Redis Cloud DB, Redis 8.4.0, single primary + 1 replica, `maxmemory_policy=noeviction`.
**Run timestamp**: 2026-05-29T22:47Z (Wave 5.15s, smoke-run-15 MVP-complete attempt).
**Dataset size**: 2 000 rows, classes GIRR + EQUITY + FX (mix 667 / 667 / 666).
**Status of this run**: 🟢 GREEN — api bootstraps in ~14 s on the standalone Redis Cloud DB; ingest reaches `num_docs=2000` (100 % density) with zero `hash_indexing_failures`; 6/6 calc variants HTTP 200 with strictly positive `charge` and every per-bucket entry populated (`count > 0`); peak Δ-over-baseline = 7.270 MB = 80.78 % of the 9 MB cap. The **Live value** column below now carries **this run's** GIRR Delta numbers (`docs/recordings/smoke-run-15/calc-girr-delta.json`); file:line references are pinned against the current `main` source tree.

---

## Clause-by-clause traceability

| # | MAR21 §21.4 clause (verbatim excerpt) | Formula | Code implementation (file:line) | Live value (GIRR Delta — smoke-run-15, Wave 5.15s, 2 000 rows) | Presenter one-liner |
|---|---|---|---|---|---|
| **3** | "*The weighted sensitivity WS_k of each net sensitivity s_k to risk factor k is calculated by multiplying the net sensitivity by the corresponding risk weight RW_k as follows.*" — `WS_k = RW_k · s_k` | `WS_k = w_k · Σ_rows s_k` (per tenor k, summed across all rows in bucket b) | `services/calc/lib/girr_delta.lua:66-72` (the `sum_s[k]` accumulation in `_delta_iter_bucket` returns Σ_rows s_k for each tenor k; the `weights[k] * sum_s[k]` multiplication on **line 70** produces WS_k) | GIRR Delta, bucket **EUR** (count = 31 rows, the largest-magnitude S_b in this run): `S_b = Σ_k WS_k = 0.214129951`. Per-tenor WS_k vector is not surfaced in the response shape, but `S_b` (its sum) is the contract-level summary — strictly non-zero on every populated bucket, demonstrating the multiplication-by-RW_k path executes end-to-end. | "Each row's tenor-vector sensitivity is risk-weighted at the Redis-shard level inside the bucket SCAN — Basel says multiply by RW_k, we do exactly that on **line 70** of `girr_delta.lua`." |
| **4** | "*The within-bucket aggregation is performed using the prescribed correlation parameter ρ_kl between weighted sensitivities WS_k and WS_l within bucket b, as follows.*" — `K_b = √( Σ WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l )` | `K_b = √( Σ_k WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l )`; constant-ρ specialisation used here: `K_b² = ΣWS² + ρ · ((ΣWS)² − ΣWS²)` | `services/calc/lib/girr_delta.lua:74-78` (line 74: `cross = sum_ws · sum_ws − sum_ws_sq` is the `(ΣWS)² − ΣWS²` term; line 75 floors cross at 0 to absorb FP noise; line 76: `kb_sq = sum_ws_sq + rho · cross` is the K_b² formula; line 78 takes the sqrt) | GIRR Delta, per bucket (all 11 buckets populated, `count > 0` everywhere): EUR K_b = **0.21329799987045** (S_b = 0.214129951, count = 31), NOK K_b = **0.19334362169263** (S_b = 0.193799719, count = 37), JPY K_b = **0.14969904835521** (S_b = 0.072343768, count = 42), OTHER K_b = **0.14580785583906** (S_b = 0.007796021, count = 36), SEK K_b = **0.14432577694863** (S_b = −0.144459307, count = 29), USD K_b = **0.14238605807267** (S_b = 0.052029324, count = 40), CAD K_b = **0.13969953698220** (S_b = −0.097213266, count = 28), AUD K_b = **0.12039665946760** (S_b = 0.022970006, count = 28), CHF K_b = **0.10930157519480** (S_b = 0.015711376, count = 25), GBP K_b = **0.10053788711678** (S_b = −0.031690035, count = 30), NZD K_b = **0.09810227402039** (S_b = −0.004178999, count = 29). Every K_b strictly positive. | "Within each bucket — same currency, same tenor curve — Basel correlates the tenor points with ρ. Look at the per-bucket K_b array: eleven populated buckets, eleven non-zero K_b values. That's clause 4 firing live in the FCALL." |
| **5** | "*The risk class-level aggregation across buckets is performed using the cross-bucket correlation γ_bc, as follows.*" — `Charge = √( Σ_b K_b² + Σ_{b≠c} γ_bc · S_b · S_c )` | `Charge = √( Σ_b K_b² + Σ_{b≠c} γ_bc · S_b · S_c )` | `services/api/src/sbm/reduce.ts:36-49` (lines 36-37: `sumK2 = Σ K_b²`; lines 39-46: double loop builds `cross = Σ_{i≠j} γ_bc · S_b · S_c` using the `gammaOf` lookup; line 48: `sum = sumK2 + cross`; line 49: returns `√sum` when the expression is non-negative). γ_bc itself is sourced from `services/api/src/sbm/correlations.ts:9-27` (per-risk-class lookup keyed off the schema YAML at `config/schema/frtb-default.yaml`). | GIRR Delta risk-class **charge = 0.46577934393808174** (from `√( Σ K_b² + Σ_{b≠c} γ_GIRR · S_b · S_c )` over the 11 buckets above, with γ_GIRR sourced from `frtb-default.yaml`). Charge is strictly positive — the positive-interior branch (line 49) is the one that fired in this run. `total_ms = 246.932`, `fanout_ms = 130.034`. | "Once each bucket has its K_b, we cross-correlate the bucket-level S_b values with the schema's γ_bc matrix and sqrt the whole thing. That's the `charge` you see in the response — clause 5, single sqrt, **line 49** of `reduce.ts`." |
| **5(b)** | "*If the expression inside the square root is negative, the risk class capital charge is calculated using the following alternative specification, where S_b is replaced by S_b* (capped within ±K_b).*" — `S_b* = max(min(S_b, K_b), −K_b)`, then `Charge = √( Σ K_b² + Σ_{b≠c} γ_bc · S_b* · S_c* )` | `S_b* = max(min(S_b, K_b), −K_b)`; `Charge = √( Σ K_b² + Σ_{b≠c} γ_bc · S_b* · S_c* )` | `services/api/src/sbm/reduce.ts:51-62` (line 52: per-bucket cap via `Math.max(Math.min(p.S_b, p.K_b), -p.K_b)` builds the `Splus` vector; lines 54-60: rebuild the cross term using `Splus`; line 61: `sumAlt = sumK2 + crossPlus`; line 62: returns `√max(sumAlt, 0)`). The branch is gated by `sum >= 0` at line 49 — only triggered when the standard expression goes negative. | **Not triggered** in this run's GIRR Delta call (the positive-interior branch returned 0.46577934393808174 at `reduce.ts:49`). The negative-interior fallback exists, is reachable from the same call, and is mathematically faithful to the MAR21 §21.4(7) alternative — it just doesn't light up on this particular bucket set. | "If clause 5's expression ever goes negative — which only happens when high-magnitude negative S_b values dominate — Basel gives us an alternative formula that clamps each S_b inside ±K_b. That fallback is **lines 51-62** of `reduce.ts`; it sits one branch away from the happy path and the reviewer can verify the inequality test on line 49 picks the right branch every time." |

---

## How to re-run this clause-trace live

The live values above were captured by smoke-run-15 (Wave 5.15s, 2 000 rows on the standalone Redis Cloud DB). To regenerate the GIRR Delta call against the same DB, the call shape is:

```
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"risk_class":"GIRR","sensitivity_type":"delta"}' \
  http://localhost:8080/calc/sbm
```

The response body's `per_bucket[*].{K_b,S_b,count}` array maps 1-to-1 onto clauses 3+4 (one row per bucket), and the top-level `charge` field is the clause-5 (or 5(b) fallback) output. Code paths above stay valid regardless of which DB serves the FCALL — they are sharded by `sens:{risk_class:bucket}:*` hash-tag, so each per-bucket FCALL stays slot-local on whichever Redis topology is in use.

---

## Provenance footnote

This pack ties Basel MAR21 §21.4 (the prescribed clause text, by clause number) to specific source lines in this repository **and** to this run's live production-shape calc output (`docs/recordings/smoke-run-15/calc-girr-delta.json`; full 6-variant matrix in `docs/recordings/smoke-run-15/calc-results.json`). It is intended as a single-page demo evidence asset for an HSBC market-risk reviewer who wants to confirm the implementation is a faithful translation of MAR21 §21.4(3)–(5) including the §21.4(7) negative-interior alternative, before approving the PoV for wider rollout.

---

## Run footer

- **Source DB host**: `lip-veil-spring-32424.db.redis.io:14596` (standalone Redis Cloud DB, Redis 8.4.0; no auth material reproduced here).
- **Run timestamp**: 2026-05-29T22:47Z.
- **Dataset size**: 2 000 rows (GIRR 667 / EQUITY 667 / FX 666); FT.INFO reports `num_docs=2000` (100 % density) and zero `hash_indexing_failures`.
- **Cost-cap status**: peak Δ-over-baseline = 7.270 MB = 80.78 % of the 9 MB cap (PASS).
- **Source artefact for the GIRR Delta Live column**: [`docs/recordings/smoke-run-15/calc-girr-delta.json`](../recordings/smoke-run-15/calc-girr-delta.json). Full 6-variant matrix + per-step verdicts: [`docs/recordings/smoke-run-15/SUMMARY.md`](../recordings/smoke-run-15/SUMMARY.md).
