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

// Wave 6.24 — materialized discovery sets. Ingest maintains three nested
// Redis Sets in lock-step with the rollup hashes so calc / facets can answer
// "which risk_classes / buckets / sensitivity_types have data?" in a single
// SMEMBERS round-trip instead of an FT.AGGREGATE over `idx:sens`.
//
// Key hierarchy:
//   * `seen:risk_class`               — set of risk classes with data. Global
//                                       (no hash tag). Single SMEMBERS for
//                                       the facets / discovery top level.
//   * `seen:bucket:{<rc>}`            — set of buckets within `<rc>`. Hash-
//                                       tagged on `<rc>` so it lives on the
//                                       slot that owns that risk class's
//                                       data. Replaces the per-class FT.
//                                       AGGREGATE discovery query in calc.
//   * `seen:sens_type:{<rc>:<bkt>}`   — set of sensitivity_types within a
//                                       (rc, bucket) bucket. Hash-tagged to
//                                       MATCH the `rollup:{<rc>:<bkt>}:…`
//                                       and `sens:{<rc>:<bkt>}:…` keys so a
//                                       single slot owns everything related
//                                       to that bucket.
export const SEEN_RISK_CLASS_KEY = "seen:risk_class";

export function seenBucketKey(rc: string): string {
  return `seen:bucket:{${rc}}`;
}

export function seenSensTypeKey(rc: string, bkt: string): string {
  return `seen:sens_type:{${rc}:${bkt}}`;
}

// Wave 6.39.G — per-entry idempotency marker for the rollup phase of the
// two-phase ingest writer. The atomic delta-reconciliation MULTI used to span
// `sens:<ulid>` and `rollup:{<rc>:<bkt>}:*` (different slots → CROSSSLOT on
// Redis Enterprise / Cluster). Route D splits the per-row write into a sens-
// slot MULTI (Phase 1) and a rollup-slot MULTI (Phase 2); this marker lives on
// the rollup slot so Phase 2 can short-circuit on replay without re-applying
// the HINCRBYFLOAT deltas. TTL is set to the stream-retention window by the
// caller so the marker disappears once the stream entry can no longer be
// re-delivered.
export function processedMarkerKey(rc: string, bkt: string, entryId: string): string {
  return `processed:{${rc}:${bkt}}:${entryId}`;
}
