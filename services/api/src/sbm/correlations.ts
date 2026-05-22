import type { Schema, CorrelationSpec as SchemaCorrelationSpec } from "@frtb/schema";
import type { CorrelationSpec } from "./reduce.ts";

// Builds a per-risk-class γ_bc lookup keyed by RISK_CLASS id (uppercase).
// Reads `correlations[<risk_class>.cross_bucket_correlation_ref]` for each
// risk class defined in the schema. Falls back to a no-correlation constant
// when the schema reference is missing — the reduce step then degrades to
// √(Σ K_b²), still a valid (conservative) charge.
export function buildCrossBucketCorrelations(schema: Schema): Record<string, CorrelationSpec> {
  const out: Record<string, CorrelationSpec> = {};
  for (const [rc, cfg] of Object.entries(schema.risk_classes)) {
    const ref = cfg.cross_bucket_correlation_ref;
    const raw: SchemaCorrelationSpec | undefined = ref ? schema.correlations[ref] : undefined;
    if (!raw) {
      out[rc] = { kind: "constant", value: 0 };
      continue;
    }
    if (raw.kind === "constant") {
      out[rc] = { kind: "constant", value: raw.value };
    } else if (raw.kind === "matrix") {
      out[rc] = { kind: "matrix", labels: raw.labels, matrix: raw.matrix };
    } else {
      out[rc] = { kind: "constant", value: 0 };
    }
  }
  return out;
}
