import type { Dimension, RiskClassId, Schema, Sensitivity } from "./types.ts";

const SENSITIVITY_TYPES = ["DELTA", "VEGA", "CURVATURE"] as const;

export function sampleRowFor(riskClass: RiskClassId, schema: Schema): Sensitivity {
  const cfg = schema.risk_classes[riskClass];
  if (!cfg) {
    throw new Error(`risk class ${riskClass} not defined in schema`);
  }
  const dimsByName = new Map<string, Dimension>();
  for (const d of schema.dimensions) dimsByName.set(d.name, d);

  const bucket = cfg.buckets.values[0] ?? "B1";
  const tenor = cfg.tenor?.nodes[0];
  const tenorCount = cfg.tenor?.count ?? 1;

  const riskValueDim = dimsByName.get(schema.frtb_binding.risk_value);
  const riskValue: number | number[] =
    riskValueDim?.type === "ARRAY_NUMERIC"
      ? Array.from({ length: tenorCount }, (_, i) => 1000 + i * 10)
      : 12345.67;

  const row: Sensitivity = {
    risk_class: riskClass,
    bucket,
    risk_value: riskValue,
    weight: 0.017,
    sensitivity_type: SENSITIVITY_TYPES[0],
  };
  if (tenor) row.tenor = tenor;

  // Populate any other dimensions in the class with deterministic placeholders
  // so generator/ingest fixtures can rely on full-shape rows.
  for (const dimName of cfg.dimensions) {
    if (dimName in row) continue;
    const d = dimsByName.get(dimName);
    if (!d) continue;
    row[dimName] = placeholderFor(d);
  }
  return row;
}

function placeholderFor(d: Dimension): unknown {
  switch (d.type) {
    case "TAG":
    case "TEXT":
      return `sample_${d.name}`;
    case "NUMERIC":
      return 0;
    case "GEO":
      return "0,0";
    case "VECTOR":
      return new Array(8).fill(0);
    case "ARRAY_NUMERIC":
      return [0];
  }
}
