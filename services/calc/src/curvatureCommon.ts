// Shared types and helpers for the MAR21 §21.5 Curvature reference oracles
// (GIRR / Equity / FX). Pure functions; no I/O; no Redis. Consumed by the
// per-class *CurvatureReference.ts modules and their Vitest unit tests.
//
// Per MAR21 §21.5(3) the intra-bucket Curvature correlation is the square
// of the Delta correlation (ρ_kl^curv = ρ_kl^delta²); per MAR21 §21.5(5)
// the cross-bucket Curvature correlation is the square of the Delta γ
// (γ_bc^curv = γ_bc^delta²). The squaring is performed here once so all
// three oracles consume Delta-shaped correlations and stay aligned with
// the YAML schema source of truth.

export type CurvatureGammaSpec =
  | { kind: "constant"; value: number }
  | { kind: "matrix"; labels: string[]; matrix: number[][] };

export interface BucketCurvature {
  bucket: string;
  K_b: number;
  K_b_up: number;
  K_b_down: number;
  S_b: number;
  S_b_up: number;
  S_b_down: number;
  direction: "up" | "down" | "tie";
  count: number;
}

export interface CurvatureResult {
  perBucket: BucketCurvature[];
  riskClassCharge: number;
  direction: "up" | "down" | "mixed";
  usedFallback: boolean;
}

// §21.5(3): ρ_kl^curv = (ρ_kl^delta)²
export function squareCorrelation(rho: number): number {
  return rho * rho;
}

// §21.5(5): γ_bc^curv = (γ_bc^delta)²
export function squareCorrelationSpec(spec: CurvatureGammaSpec): CurvatureGammaSpec {
  if (spec.kind === "constant") {
    return { kind: "constant", value: spec.value * spec.value };
  }
  return {
    kind: "matrix",
    labels: spec.labels.slice(),
    matrix: spec.matrix.map((row) => row.map((v) => v * v)),
  };
}

// ψ(a, b) per §21.5(3) and §21.5(5): zero when both arguments are strictly
// negative, one otherwise. Both bucket-level and risk-class-level cross
// terms gate on this indicator.
export function psi(a: number, b: number): number {
  return a < 0 && b < 0 ? 0 : 1;
}

// §21.5(3): K_b^{up|down}² = Σ_k CVR_k² + Σ_{k≠l} ρ_curv · CVR_k · CVR_l · ψ(CVR_k, CVR_l)
// Returns the raw (possibly negative) interior; callers clamp to ≥0 via the
// §21.5(5)(b) fallback shape (Math.max(0, .)) when materialising K_b.
export function kbSquaredForDirection(
  cvr: ReadonlyArray<number>,
  rhoCurv: number,
): number {
  let sumSq = 0;
  for (const x of cvr) sumSq += x * x;
  let cross = 0;
  for (let k = 0; k < cvr.length; k++) {
    const a = cvr[k]!;
    for (let l = 0; l < cvr.length; l++) {
      if (k === l) continue;
      const b = cvr[l]!;
      cross += rhoCurv * a * b * psi(a, b);
    }
  }
  return sumSq + cross;
}

function gammaOf(
  corr: CurvatureGammaSpec,
  labelIdx: Map<string, number>,
  b: string,
  c: string,
): number {
  if (corr.kind === "constant") return corr.value;
  const i = labelIdx.get(b);
  const j = labelIdx.get(c);
  if (i === undefined || j === undefined) return 0;
  return corr.matrix[i]?.[j] ?? 0;
}

// §21.5(5): Curvature risk-class charge =
//   √ max(0, Σ_b K_b² + Σ_{b≠c} γ²_bc · S_b · S_c · ψ(S_b, S_c))
// §21.5(5)(b) fallback: when the interior is negative, recompute with
// S_b clipped into [-K_b, +K_b] (mirrors the §21.4(7) clip-and-recompute
// pattern in services/api/src/sbm/reduce.ts).
//
// Text-fidelity caveat: Implements §21.5(5)(b) by clipping to ±K_b
// (consistent with §21.4(7) reduce.ts:51-62 shape). A strict
// Curvature-only reading of §21.5(5)(b) clips negatives to 0; flagged
// for the bank's business sign-off before production.
export function aggregateAcrossBuckets(
  per: ReadonlyArray<BucketCurvature>,
  gammaCurv: CurvatureGammaSpec,
): { charge: number; usedFallback: boolean } {
  if (per.length === 0) return { charge: 0, usedFallback: false };
  const labelIdx = new Map<string, number>();
  if (gammaCurv.kind === "matrix") {
    gammaCurv.labels.forEach((l, i) => labelIdx.set(l, i));
  }

  let sumK2 = 0;
  for (const p of per) sumK2 += p.K_b * p.K_b;

  let cross = 0;
  for (let i = 0; i < per.length; i++) {
    for (let j = 0; j < per.length; j++) {
      if (i === j) continue;
      const g = gammaOf(gammaCurv, labelIdx, per[i]!.bucket, per[j]!.bucket);
      cross += g * per[i]!.S_b * per[j]!.S_b * psi(per[i]!.S_b, per[j]!.S_b);
    }
  }

  const sum = sumK2 + cross;
  if (sum >= 0) return { charge: Math.sqrt(sum), usedFallback: false };

  // §21.5(5)(b) alternative: clip S_b ∈ [-K_b, +K_b] and recompute.
  const Sclip = per.map((p) => Math.max(Math.min(p.S_b, p.K_b), -p.K_b));
  let crossAlt = 0;
  for (let i = 0; i < per.length; i++) {
    for (let j = 0; j < per.length; j++) {
      if (i === j) continue;
      const g = gammaOf(gammaCurv, labelIdx, per[i]!.bucket, per[j]!.bucket);
      crossAlt += g * Sclip[i]! * Sclip[j]! * psi(Sclip[i]!, Sclip[j]!);
    }
  }
  const sumAlt = sumK2 + crossAlt;
  return { charge: Math.sqrt(Math.max(sumAlt, 0)), usedFallback: true };
}

// §21.5(3): given the up/down CVR vectors for a single bucket, materialise
// K_b^+, K_b^-, S_b^+, S_b^-, and pick the worse direction. S_b is the
// signed Σ_k CVR_k of the winning direction (used by §21.5(5)).
export function resolveBucketCurvature(
  bucket: string,
  cvrUp: ReadonlyArray<number>,
  cvrDown: ReadonlyArray<number>,
  rhoCurv: number,
  count: number,
): BucketCurvature {
  const kbUpSq = kbSquaredForDirection(cvrUp, rhoCurv);
  const kbDownSq = kbSquaredForDirection(cvrDown, rhoCurv);
  const K_b_up = Math.sqrt(Math.max(0, kbUpSq));
  const K_b_down = Math.sqrt(Math.max(0, kbDownSq));
  let S_b_up = 0;
  for (const x of cvrUp) S_b_up += x;
  let S_b_down = 0;
  for (const x of cvrDown) S_b_down += x;
  let direction: "up" | "down" | "tie";
  let K_b: number;
  let S_b: number;
  if (K_b_up > K_b_down) {
    direction = "up";
    K_b = K_b_up;
    S_b = S_b_up;
  } else if (K_b_down > K_b_up) {
    direction = "down";
    K_b = K_b_down;
    S_b = S_b_down;
  } else {
    direction = "tie";
    K_b = K_b_up;
    S_b = S_b_up;
  }
  return { bucket, K_b, K_b_up, K_b_down, S_b, S_b_up, S_b_down, direction, count };
}

// §21.5(5): collapse per-bucket directions into a risk-class label.
// "up" if every bucket picked up (or tied), "down" if every bucket picked
// down (or tied), otherwise "mixed".
export function summariseDirection(per: ReadonlyArray<BucketCurvature>): "up" | "down" | "mixed" {
  let sawUp = false;
  let sawDown = false;
  for (const p of per) {
    if (p.direction === "up") sawUp = true;
    else if (p.direction === "down") sawDown = true;
  }
  if (sawUp && sawDown) return "mixed";
  if (sawDown) return "down";
  return "up";
}
