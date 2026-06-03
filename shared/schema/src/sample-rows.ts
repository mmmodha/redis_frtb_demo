import type { Dimension, RiskClassId, Schema, Sensitivity, SensitivityRiskValue } from "./types.ts";

const SENSITIVITY_TYPES = ["DELTA", "VEGA", "CURVATURE"] as const;

// Wave 5.52 — deterministic per-class seed for the sparse-tenor preview so the
// rendered sample is byte-stable across renders for a given riskClass. A tiny
// in-file LCG (mulberry32) avoids pulling seedrandom into the schema package.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 0x9E3779B1 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x85EBCA6B) >>> 0;
  return h >>> 0;
}

export function sampleRowFor(riskClass: RiskClassId, schema: Schema): Sensitivity {
  const cfg = schema.risk_classes[riskClass];
  if (!cfg) {
    throw new Error(`risk class ${riskClass} not defined in schema`);
  }
  const dimsByName = new Map<string, Dimension>();
  for (const d of schema.dimensions) dimsByName.set(d.name, d);

  const bucket = cfg.buckets.values[0] ?? "B1";
  const tenor = cfg.tenor?.nodes[0];
  const tenorNodes = cfg.tenor?.nodes ?? [];

  const riskValueDim = dimsByName.get(schema.frtb_binding.risk_value);
  // Wave 5.17a — DELTA sample uses the per-(class × sens_type) object shape:
  //   GIRR Delta/Vega → keyed by tenor labels; Equity/FX Delta/Vega → { spot }.
  // Wave 5.52 — mirror the generator's K∈[5..10] sparse-tenor draw when the
  // class declares ≥5 tenors so the row preview matches what the generator
  // emits. RNG is seeded per-riskClass so the preview is stable across renders.
  let riskValue: SensitivityRiskValue;
  if (riskValueDim?.type === "ARRAY_NUMERIC" && tenorNodes.length > 1) {
    if (tenorNodes.length >= 5) {
      const rng = mulberry32(hashSeed(`sample-rv:${String(riskClass)}`));
      const K = 5 + Math.floor(rng() * 6);
      const k = Math.min(K, tenorNodes.length);
      const idx = new Array<number>(tenorNodes.length);
      for (let j = 0; j < tenorNodes.length; j++) idx[j] = j;
      for (let j = 0; j < k; j++) {
        const swap = j + Math.floor(rng() * (tenorNodes.length - j));
        const tmp = idx[j]!; idx[j] = idx[swap]!; idx[swap] = tmp;
      }
      const picked = new Uint8Array(tenorNodes.length);
      for (let j = 0; j < k; j++) picked[idx[j]!] = 1;
      const obj: Record<string, number> = {};
      for (let j = 0; j < tenorNodes.length; j++) {
        if (picked[j]) obj[tenorNodes[j]!] = 1000 + j * 10;
      }
      riskValue = obj;
    } else {
      riskValue = Object.fromEntries(tenorNodes.map((t, i) => [t, 1000 + i * 10]));
    }
  } else {
    riskValue = { spot: 12345.67 };
  }

  const row: Sensitivity = {
    risk_class: riskClass,
    bucket,
    risk_value: riskValue,
    weight: 0.017,
    sensitivity_type: SENSITIVITY_TYPES[0],
    trade_id: "T0001",
    risk_factor: `RF_${riskClass}_01`,
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
