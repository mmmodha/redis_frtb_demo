// Risk-class charge reduce step (Basel MAR21.4):
//   charge = sqrt( Σ K_b² + Σ_{b≠c} γ_bc · S_b · S_c )
// When the value inside the sqrt is negative (MAR21.4(7)), an alternative
// formula caps S_b inside [-K_b, +K_b] before recomputing.

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
