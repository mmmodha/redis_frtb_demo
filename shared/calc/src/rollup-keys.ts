// Wave 6.14a — canonical key + field-name constructors for the per-bucket
// rollup hashes that the ingest consumer writes incrementally and calc reads
// directly on the fast path. Both ingest and calc import this module so the
// key shape and field set stay in lock-step.
//
// Key shape mirrors the locked `sens:{<rc>:<bkt>}:<ulid>` contract — the
// literal `{...}` braces wrap the `<risk_class>:<bucket>` hash-tag so the
// rollup hash co-locates with the per-bucket sens keys on the same Redis
// Cluster slot (keeps any FCALL / pipeline that touches both slot-local).

// Returns the rollup hash key for a (risk_class, bucket, sensitivity_type)
// triple, optionally narrowed to a single tenor. Tenor-less form holds the
// scalar (Equity / FX) or Σ_t (GIRR) aggregate; tenor form holds the
// per-tenor breakdown used by perTenor classes (GIRR Delta/Vega/Curvature).
export function rollupKey(
  rc: string,
  bkt: string,
  sens: string,
  tenor?: string,
): string {
  const base = `rollup:{${rc}:${bkt}}:${sens}`;
  return tenor != null ? `${base}:tenor:${tenor}` : base;
}

// Canonical HASH fields for scalar (Delta / Vega) rollups. `sum_ws` is the
// running Σ of per-row weighted sensitivities; `sum_ws_sq` is the running
// Σ of (weighted sensitivity)²; `count` is the contributing-row count.
export const ROLLUP_FIELDS_SCALAR = ["sum_ws", "sum_ws_sq", "count"] as const;
export type RollupFieldScalar = (typeof ROLLUP_FIELDS_SCALAR)[number];

// Canonical HASH fields for Curvature rollups — sign-split so the calc
// reduce can apply the ψ-gate + max(K_up, K_down) without re-reading the
// underlying docs.
export const ROLLUP_FIELDS_CURVATURE = [
  "sum_ws_up",
  "sum_ws_up_sq",
  "sum_ws_down",
  "sum_ws_down_sq",
  "count",
] as const;
export type RollupFieldCurvature = (typeof ROLLUP_FIELDS_CURVATURE)[number];
