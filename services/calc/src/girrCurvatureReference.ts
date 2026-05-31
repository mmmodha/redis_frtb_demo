// Pure-TypeScript reference (oracle) for the GIRR Curvature charge math.
// Will mirror the Lua function frtb.girr_curvature (delivered in Wave 5.16b);
// here it is the canonical formula reference for integration tests and the
// api service / Python validation tooling.
//
// Per MAR21 §21.5(2)–(3) and §21.5(5): each input row carries a
// pre-computed per-tenor CVR_k^+ / CVR_k^- pair (shape A — the bank's
// pricing system already shocks-and-Delta-strips per §21.5(2), so the
// oracle skips revaluation and consumes the CVR vectors directly). Within
// a bucket, per-tenor CVR_k contributions sum additively across rows,
// mirroring how girrDeltaReference.ts aggregates per-tenor sensitivities.
//
// Math (binding):
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

export interface GirrCurvatureRow {
  sensitivity_type: string;
  bucket: string;
  // Shape A per docs/demo/curvature-scope.md §3a:
  //   { cvr_up: number[T], cvr_down: number[T] } per-tenor (T = schema.tenors)
  risk_value: unknown;
}

export interface GirrCurvatureSchema {
  tenors: number;
  // Delta intra-bucket correlation; squared to ρ_curv per §21.5(3).
  intraBucketRhoDelta: number;
  // Delta cross-bucket γ; squared to γ_curv per §21.5(5).
  crossBucketGammaDelta: CurvatureGammaSpec;
  // Optional explicit bucket ordering; otherwise sorted ascending.
  bucketOrder?: string[];
}

interface BucketAccum {
  cvrUp: number[];
  cvrDown: number[];
  count: number;
}

function readVector(raw: unknown, key: "cvr_up" | "cvr_down", T: number): number[] | null {
  if (raw === null || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return null;
  const out = new Array<number>(T).fill(0);
  for (let k = 0; k < T && k < v.length; k++) {
    const s = v[k];
    if (typeof s === "number" && Number.isFinite(s)) out[k] = s;
  }
  return out;
}

export function computeGirrCurvatureCharge(
  rows: ReadonlyArray<GirrCurvatureRow>,
  schema: GirrCurvatureSchema,
): CurvatureResult {
  const T = schema.tenors;
  const rhoCurv = squareCorrelation(schema.intraBucketRhoDelta); // §21.5(3)
  const gammaCurv = squareCorrelationSpec(schema.crossBucketGammaDelta); // §21.5(5)

  const buckets = new Map<string, BucketAccum>();
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Curvature") continue;
    if (typeof row.bucket !== "string" || row.bucket.length === 0) continue;
    const up = readVector(row.risk_value, "cvr_up", T);
    const down = readVector(row.risk_value, "cvr_down", T);
    if (!up || !down) continue;
    let accum = buckets.get(row.bucket);
    if (!accum) {
      accum = { cvrUp: new Array<number>(T).fill(0), cvrDown: new Array<number>(T).fill(0), count: 0 };
      buckets.set(row.bucket, accum);
    }
    for (let k = 0; k < T; k++) {
      accum.cvrUp[k] = (accum.cvrUp[k] ?? 0) + (up[k] ?? 0);
      accum.cvrDown[k] = (accum.cvrDown[k] ?? 0) + (down[k] ?? 0);
    }
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
