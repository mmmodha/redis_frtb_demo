// Risk-class charge reduce step (Basel MAR21.4 + MAR21.5):
//   Delta/Vega: charge = sqrt( Σ K_b² + Σ_{b≠c} γ_bc · S_b · S_c )      §21.4(5)
//     When the interior is negative (§21.4(7)), the alternative formula caps
//     S_b inside [-K_b, +K_b] before recomputing.
//   Curvature: same shape, with two differences (§21.5(5)):
//     1. γ_bc^curv = (γ_bc^delta)²  (auto-derived from the Delta spec).
//     2. ψ rule: ψ(S_b, S_c) = 0 when BOTH are < 0, else 1 — gates each
//        off-diagonal term.
//     Negative-interior fallback per §21.5(5)(b) reuses the clip-to-±K_b
//     shape (see services/calc/src/curvatureCommon.ts for the shared kernel
//     and the strict-reading caveat documented there).

import {
  aggregateAcrossBuckets,
  squareCorrelationSpec,
  type CurvatureGammaSpec,
} from "@frtb/calc/src/curvatureCommon.ts";

export type CorrelationSpec =
  | { kind: "constant"; value: number }
  | { kind: "matrix"; labels: string[]; matrix: number[][] };

// Wave 5.31b — Basel MAR21.6 three correlation regimes (low / medium / high).
// Reporting under all three is a regulatory expectation; the cross-bucket γ
// matrix is scaled uniformly by `CORRELATION_REGIME_FACTOR[regime]` and each
// entry is then capped symmetrically at ±1 because correlations may not
// exceed unity in magnitude (a 0.95 ρ × 1.25 = 1.1875 clamps back to 1.0).
export type CorrelationRegime = "low" | "medium" | "high";
export const CORRELATION_REGIME_FACTOR: Record<CorrelationRegime, number> = {
  low: 0.75,
  medium: 1.0,
  high: 1.25,
};

// Pure, non-mutating γ scaler. Factor 1.0 returns the input unchanged (same
// reference) so the medium-regime fast path is a no-op for the reducers. The
// cap is applied symmetrically since negative correlations are valid (a
// ρ = -0.95 with the high factor would otherwise clamp to -1.1875).
export function scaleCorrelationSpec(
  spec: CorrelationSpec,
  factor: number,
  cap: number = 1.0
): CorrelationSpec {
  if (factor === 1.0) return spec;
  const clamp = (v: number) => Math.max(-cap, Math.min(cap, v * factor));
  if (spec.kind === "constant") {
    return { kind: "constant", value: clamp(spec.value) };
  }
  return {
    kind: "matrix",
    labels: spec.labels.slice(),
    matrix: spec.matrix.map((row) => row.map(clamp)),
  };
}

// Wave 5.96A — per-bucket drilldown intermediates. Populated by the fast path
// reducer in aggregate-via-index.ts; left undefined for the Lua FCALL path
// (intermediates are computed inside the kernel and not surfaced). The UI
// renders the "How K_b was calculated" panel from these fields when present
// and a "computed in Lua FCALL, intermediates not surfaced" message otherwise.
export type BucketPath = "fast" | "lua";
// Wave 5.96A.1 — per-component breakdown so the drilldown UI can show the
// individual WS_k / WS_k² that summed into ws_squared_sum and the dominant
// pairwise rho·WS_k·WS_l contributions that summed into cross_term.
export interface WsComponent {
  k: string;
  ws: number;
  ws_squared: number;
}
export interface CrossComponent {
  k: string;
  l: string;
  rho: number;
  ws_k: number;
  ws_l: number;
  contrib: number;
}
export interface CvrComponent {
  k: string;
  cvr_up: number;
  cvr_down: number;
}
export interface BucketCurvatureIntermediate {
  k_plus: number;
  k_minus: number;
  winner: "plus" | "minus";
  // Wave 5.96A.1 — per-risk-factor CVR pairs whose signed sums precede the
  // §21.5(3) max selection. Σ cvr_up over components matches the K_b^+
  // precursor; same for cvr_down / K_b^-.
  cvr_components?: CvrComponent[];
}
export interface BucketIntermediate {
  path: BucketPath;
  ws_squared_sum?: number;
  cross_term?: number;
  curvature?: BucketCurvatureIntermediate;
  // Wave 5.96A.1 — additive per-component arrays. Present on the fast path
  // only when the route asks for them; absent on the Lua path.
  ws_components?: WsComponent[];
  cross_components?: CrossComponent[];
  cross_components_truncated?: boolean;
  cross_components_total_count?: number;
}
export interface BucketResult {
  bucket: string;
  K_b: number;
  S_b: number;
  count: number;
  ms: number;
  // Wave 5.96A — additive. Optional so the legacy Lua path can omit it (the
  // route then synthesises an `intermediate.path: "lua"` stub).
  intermediate?: BucketIntermediate;
}

function gammaOf(corr: CorrelationSpec, idx: Map<string, number>, b: string, c: string): number {
  if (corr.kind === "constant") return corr.value;
  const i = idx.get(b);
  const j = idx.get(c);
  if (i === undefined || j === undefined) return 0;
  return corr.matrix[i]?.[j] ?? 0;
}

export function reduceRiskClassCharge(
  per: BucketResult[],
  corr: CorrelationSpec
): number {
  if (per.length === 0) return 0;
  const labelIdx = new Map<string, number>();
  if (corr.kind === "matrix") {
    corr.labels.forEach((l, i) => labelIdx.set(l, i));
  }

  let sumK2 = 0;
  for (const p of per) sumK2 += p.K_b * p.K_b;

  let cross = 0;
  for (let i = 0; i < per.length; i++) {
    for (let j = 0; j < per.length; j++) {
      if (i === j) continue;
      const g = gammaOf(corr, labelIdx, per[i]!.bucket, per[j]!.bucket);
      cross += g * per[i]!.S_b * per[j]!.S_b;
    }
  }

  const sum = sumK2 + cross;
  if (sum >= 0) return Math.sqrt(sum);

  // MAR21.4(7) alternative: cap S_b inside [-K_b, +K_b]
  const Splus = per.map((p) => Math.max(Math.min(p.S_b, p.K_b), -p.K_b));
  let crossPlus = 0;
  for (let i = 0; i < per.length; i++) {
    for (let j = 0; j < per.length; j++) {
      if (i === j) continue;
      const g = gammaOf(corr, labelIdx, per[i]!.bucket, per[j]!.bucket);
      crossPlus += g * Splus[i]! * Splus[j]!;
    }
  }
  const sumAlt = sumK2 + crossPlus;
  return Math.sqrt(Math.max(sumAlt, 0));
}

// §21.5(5) cross-bucket Curvature aggregation. Structurally identical to
// reduceRiskClassCharge but with γ_bc^curv = (γ_bc^delta)² and the ψ-gated
// cross term (ψ=0 when both S_b values are strictly negative). The
// negative-interior fallback follows §21.5(5)(b) using the clip-to-±K_b
// shape that mirrors §21.4(7) for Delta. The shared kernel lives in
// services/calc/src/curvatureCommon.ts so this module and the per-class
// reference oracles consume identical math.
//
// Input contract matches reduceRiskClassCharge: per-bucket {K_b, S_b} have
// already been resolved by the FCALL layer (the Lua girr_curvature /
// equity_curvature / fx_curvature functions pick the worse direction per
// §21.5(3) and return the winning K_b and signed S_b). `deltaCorr` is the
// Delta γ_bc spec; it is squared internally per §21.5(5).
//
// Returns both the charge and `usedFallback`: true when the §21.5(5)
// interior went negative and the §21.5(5)(b) clip-to-±K_b recompute fired.
// The route layer surfaces this as the response `curvature_branch` so the
// UI can label which regulatory branch produced the number.
export function reduceCurvatureCharge(
  per: BucketResult[],
  deltaCorr: CorrelationSpec
): { charge: number; usedFallback: boolean } {
  if (per.length === 0) return { charge: 0, usedFallback: false };
  const gammaCurv: CurvatureGammaSpec = squareCorrelationSpec(deltaCorr as CurvatureGammaSpec);
  const adapted = per.map((p) => ({
    bucket: p.bucket,
    K_b: p.K_b,
    S_b: p.S_b,
    K_b_up: 0,
    K_b_down: 0,
    S_b_up: 0,
    S_b_down: 0,
    direction: "tie" as const,
    count: p.count,
  }));
  return aggregateAcrossBuckets(adapted, gammaCurv);
}
