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

export interface BucketResult {
  bucket: string;
  K_b: number;
  S_b: number;
  count: number;
  ms: number;
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
export function reduceCurvatureCharge(
  per: BucketResult[],
  deltaCorr: CorrelationSpec
): number {
  if (per.length === 0) return 0;
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
  const { charge } = aggregateAcrossBuckets(adapted, gammaCurv);
  return charge;
}
