// Infer a column → FRTB-binding mapping from a sample of detected columns.
//
// Strategy:
//   1. Group `tenor_<period>` NUMERIC columns into a single `risk_value`
//      array binding (this is how Wave 2's "wide" tenor files arrive).
//   2. For each remaining FRTB binding dimension, pick the first column
//      whose name normalises to the binding key or its target dimension.
//   3. NUMERIC columns picked up by the binding get a `type: "number"`
//      tag so the ingest stage knows to coerce.

import type { Schema } from "@frtb/schema";
import type { InferredColumn } from "./types.ts";

export type MappingValueType = "string" | "number" | "array_number";

export interface MappedField {
  from: string | string[];
  type?: MappingValueType;
}

export interface ColumnMapping {
  fields: Record<string, MappedField>;
}

export interface InferMappingInput {
  schema: Schema;
  columns: InferredColumn[];
}

const TENOR_ARRAY_PATTERN = /^tenor[_\- ]?(.+)$/i;

export function inferMapping({ schema, columns }: InferMappingInput): ColumnMapping {
  const fields: Record<string, MappedField> = {};

  // Step 1 — tenor-array detection.
  const tenorArrayCols = columns.filter(
    (c) => TENOR_ARRAY_PATTERN.test(c.name) && c.detected_type === "NUMERIC",
  );
  const usedColumns = new Set<string>();
  if (tenorArrayCols.length >= 2) {
    fields.risk_value = {
      from: tenorArrayCols.map((c) => c.name),
      type: "array_number",
    };
    for (const c of tenorArrayCols) usedColumns.add(c.name);
  }

  // Step 2 — per-binding direct match.
  const binding = schema.frtb_binding as unknown as Record<string, string>;
  for (const [bindingKey, bindingTarget] of Object.entries(binding)) {
    if (fields[bindingKey]) continue; // already assigned (risk_value array)
    const candidateNorms = new Set([
      normalise(bindingKey),
      normalise(bindingTarget),
    ]);
    const match = columns.find(
      (c) => !usedColumns.has(c.name) && candidateNorms.has(normalise(c.name)),
    );
    if (!match) continue;
    const field: MappedField = { from: match.name };
    if (match.detected_type === "NUMERIC") field.type = "number";
    fields[bindingKey] = field;
    usedColumns.add(match.name);
  }

  return { fields };
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, "");
}
