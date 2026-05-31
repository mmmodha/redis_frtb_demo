// Pure-TypeScript reference (oracle) for the FX Curvature charge math.
// Will mirror the Lua function frtb.fx_curvature (delivered in Wave 5.16b);
// here it is the canonical formula reference for integration tests.
//
// Per MAR21 §21.5(2)–(3) and §21.5(5) with shape A inputs (pre-computed
// CVR_k^+/CVR_k^- per row — each row is a distinct FX risk factor k,
// mirroring how fxDeltaReference.ts treats each row as a factor):
//
//   CVR_k^{+|-} arrives pre-computed per §21.5(2)(a)/(b).
//   K_b^{+|-}² = Σ_k CVR_k² + Σ_{k≠l} ρ_curv · CVR_k · CVR_l · ψ(.)  §21.5(3)
//   K_b       = max(K_b^+, K_b^-)                                     §21.5(3)
//   S_b       = Σ_k CVR_k  of the winning direction                   §21.5(5)
//   charge    = √ max(0, Σ_b K_b² + Σ_{b≠c} γ_curv · S_b · S_c · ψ)   §21.5(5)
//   ρ_curv = ρ_delta², γ_curv = γ_delta² (auto-derived in curvatureCommon).
//   §21.5(5)(b) negative-interior fallback: clip S_b ∈ [-K_b, +K_b].

import {
  type CurvatureGammaSpec,
  type CurvatureResult,
  aggregateAcrossBuckets,
  resolveBucketCurvature,
  squareCorrelation,
  squareCorrelationSpec,
  summariseDirection,
} from "./curvatureCommon.ts";

export interface FxCurvatureRow {
  sensitivity_type: string;
  bucket: string;
  // Shape A per docs/demo/curvature-scope.md §3a:
  //   { cvr_up: number, cvr_down: number } scalar per FX factor k.
  risk_value: unknown;
}

export interface FxCurvatureSchema {
  // Delta intra-bucket correlation (PoV scalar constant); squared per §21.5(3).
  // Defaults to 0 to match the fxDeltaReference convention.
  intraBucketRhoDelta?: number;
  // Delta cross-bucket γ; squared per §21.5(5). Defaults to constant 0.
  crossBucketGammaDelta?: CurvatureGammaSpec;
  // Optional explicit bucket ordering; otherwise sorted ascending.
  bucketOrder?: string[];
}

interface BucketAccum {
  cvrUp: number[];
  cvrDown: number[];
  count: number;
}

function readScalarPair(raw: unknown): { up: number; down: number } | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const up = obj.cvr_up;
  const down = obj.cvr_down;
  if (typeof up !== "number" || !Number.isFinite(up)) return null;
  if (typeof down !== "number" || !Number.isFinite(down)) return null;
  return { up, down };
}

export function computeFxCurvatureCharge(
  rows: ReadonlyArray<FxCurvatureRow>,
  schema: FxCurvatureSchema = {},
): CurvatureResult {
  const rhoCurv = squareCorrelation(schema.intraBucketRhoDelta ?? 0); // §21.5(3)
  const gammaCurv = squareCorrelationSpec(
    schema.crossBucketGammaDelta ?? { kind: "constant", value: 0 },
  ); // §21.5(5)

  const buckets = new Map<string, BucketAccum>();
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Curvature") continue;
    if (typeof row.bucket !== "string" || row.bucket.length === 0) continue;
    const pair = readScalarPair(row.risk_value);
    if (!pair) continue;
    let accum = buckets.get(row.bucket);
    if (!accum) {
      accum = { cvrUp: [], cvrDown: [], count: 0 };
      buckets.set(row.bucket, accum);
    }
    accum.cvrUp.push(pair.up);
    accum.cvrDown.push(pair.down);
    accum.count += 1;
  }

  const ordered = schema.bucketOrder
    ? schema.bucketOrder.filter((b) => buckets.has(b))
    : Array.from(buckets.keys()).sort();
  const perBucket = ordered.map((b) => {
    const accum = buckets.get(b)!;
    return resolveBucketCurvature(b, accum.cvrUp, accum.cvrDown, rhoCurv, accum.count); // §21.5(3)
  });

  const { charge, usedFallback } = aggregateAcrossBuckets(perBucket, gammaCurv); // §21.5(5)/(5)(b)
  return {
    perBucket,
    riskClassCharge: charge,
    direction: summariseDirection(perBucket),
    usedFallback,
  };
}
