// Core schema types for the FRTB-SA hot-swappable schema layer.
// Hand-authored; the generator emits derived discriminated types alongside.

export type DimensionType =
  | "TAG"
  | "NUMERIC"
  | "TEXT"
  | "GEO"
  | "VECTOR"
  | "ARRAY_NUMERIC";

export type HashTagRole = "primary" | "secondary";

export interface Dimension {
  name: string;
  type: DimensionType;
  indexed: boolean;
  sortable: boolean;
  cardinality_hint?: number | string;
  hash_tag_role?: HashTagRole;
  description?: string;
}

export interface BucketScheme {
  naming: string;
  values: string[];
}

export interface TenorScheme {
  count: number;
  nodes: string[];
}

export interface RiskClassConfig {
  dimensions: string[];
  buckets: BucketScheme;
  tenor?: TenorScheme;
  risk_weights_ref: string;
  intra_bucket_correlation_ref: string;
  cross_bucket_correlation_ref: string;
}

export interface FrtbBinding {
  risk_class: string;
  bucket: string;
  tenor: string;
  risk_value: string;
  weight: string;
  sensitivity_type: string;
}

export type RiskWeightTable =
  | {
      description?: string;
      by_tenor: Record<string, number>;
    }
  | {
      description?: string;
      by_bucket: Record<string, number>;
    }
  | {
      description?: string;
      constant: number;
    };

export type CorrelationSpec =
  | { description?: string; kind: "constant"; value: number }
  | { description?: string; kind: "matrix"; labels: string[]; matrix: number[][] };

export interface Schema {
  version: number;
  dimensions: Dimension[];
  risk_classes: Record<string, RiskClassConfig>;
  frtb_binding: FrtbBinding;
  risk_weights: Record<string, RiskWeightTable>;
  correlations: Record<string, CorrelationSpec>;
}

// Canonical FRTB-SA risk class identifiers (BCBS d457 / MAR21 §21.4).
export const RISK_CLASSES = [
  "GIRR",
  "CSR_NON_SEC",
  "CSR_SEC_NON_CTP",
  "CSR_SEC_CTP",
  "EQUITY",
  "COMMODITY",
  "FX",
] as const;
export type RiskClassId = (typeof RISK_CLASSES)[number];

// Risk-value shape is discriminated by (risk_class, sensitivity_type):
//   - GIRR Delta/Vega → `{ <tenor>: number }` (object keyed by tenor labels from
//     schema.risk_classes.GIRR.tenor.nodes, e.g. `{ "3M": v0, "6M": v1, ... }`).
//   - Equity/FX Delta/Vega → `{ spot: number }`.
//   - GIRR Curvature → `{ cvr_up: number[], cvr_down: number[] }` (per-tenor).
//   - Equity/FX Curvature → `{ cvr_up: number, cvr_down: number }` (scalar).
//   - Bare `number` / `number[]` are accepted by downstream readers for legacy
//     test fixtures, but the production generator emits the object shapes above.
export type SensitivityRiskValue =
  | number
  | number[]
  | { spot: number }
  | { [tenorLabel: string]: number }
  | { cvr_up: number; cvr_down: number }
  | { cvr_up: number[]; cvr_down: number[] };

// A single FRTB sensitivity row as stored in Redis JSON.
// Dimension keys are open-ended because the schema is hot-swappable;
// the generated.ts file produced by tools/schema-cli narrows this per-class.
export interface Sensitivity {
  risk_class: RiskClassId;
  bucket: string;
  tenor?: string;
  risk_value: SensitivityRiskValue;
  weight?: number;
  sensitivity_type: "DELTA" | "VEGA" | "CURVATURE";
  /** Tenant trade identifier (e.g. `T0001`); pool size controlled by generator. */
  trade_id?: string;
  /** Tenant risk-factor tag (e.g. `RF_GIRR_01`); 16 per class by default. */
  risk_factor?: string;
  [field: string]: unknown;
}
