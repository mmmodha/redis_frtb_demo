// Failing tests for column → FRTB binding mapping inference.
//
// The inferer fuzzy-matches detected columns against the schema's
// `frtb_binding` section + `dimensions` names. Tenor-array columns
// (e.g. `tenor_3M`, `tenor_6M`, ...) are grouped and suggested as the
// `risk_value` array dimension.

import { describe, it, expect } from "vitest";
import type { Schema } from "@frtb/schema";
import { inferMapping } from "../src/infer/mapping.ts";
import type { InferredColumn } from "../src/infer/types.ts";

function fakeSchema(): Schema {
  return {
    version: 1,
    dimensions: [
      { name: "risk_class", type: "TAG", indexed: true, sortable: false },
      { name: "bucket", type: "TAG", indexed: true, sortable: false },
      { name: "tenor", type: "TAG", indexed: true, sortable: true },
      { name: "risk_value", type: "ARRAY_NUMERIC", indexed: false, sortable: false },
      { name: "weight", type: "NUMERIC", indexed: false, sortable: false },
      { name: "sensitivity_type", type: "TAG", indexed: true, sortable: false },
      { name: "trade_id", type: "TAG", indexed: false, sortable: false },
      { name: "book", type: "TAG", indexed: false, sortable: false },
    ],
    risk_classes: {},
    frtb_binding: {
      risk_class: "risk_class",
      bucket: "bucket",
      tenor: "tenor",
      risk_value: "risk_value",
      weight: "weight",
      sensitivity_type: "sensitivity_type",
    },
    risk_weights: {},
    correlations: {},
  };
}

function col(name: string, type: InferredColumn["detected_type"] = "TAG"): InferredColumn {
  return { name, detected_type: type, sample_values: [] };
}

describe("inferMapping — exact and obvious matches", () => {
  it("maps columns that match an FRTB binding name verbatim", () => {
    const m = inferMapping({
      schema: fakeSchema(),
      columns: [
        col("risk_class"), col("bucket"), col("sensitivity_type"),
        col("tenor"), col("risk_value", "NUMERIC"), col("weight", "NUMERIC"),
      ],
    });
    expect(m.fields.risk_class).toEqual({ from: "risk_class" });
    expect(m.fields.bucket).toEqual({ from: "bucket" });
    expect(m.fields.tenor).toEqual({ from: "tenor" });
    expect(m.fields.risk_value).toEqual({ from: "risk_value", type: "number" });
    expect(m.fields.weight).toEqual({ from: "weight", type: "number" });
    expect(m.fields.sensitivity_type).toEqual({ from: "sensitivity_type" });
  });

  it("uses case-insensitive matching", () => {
    const m = inferMapping({
      schema: fakeSchema(),
      columns: [col("Risk_Class"), col("BUCKET"), col("Sensitivity_Type")],
    });
    expect(m.fields.risk_class).toEqual({ from: "Risk_Class" });
    expect(m.fields.bucket).toEqual({ from: "BUCKET" });
    expect(m.fields.sensitivity_type).toEqual({ from: "Sensitivity_Type" });
  });

  it("normalises separator variants (snake/camel/space/dash) when matching", () => {
    const m = inferMapping({
      schema: fakeSchema(),
      columns: [col("riskClass"), col("Risk Class"), col("risk-class")],
    });
    // first column wins on tie; all three should resolve to risk_class binding.
    expect(m.fields.risk_class?.from).toBeDefined();
    expect(["riskClass", "Risk Class", "risk-class"]).toContain(m.fields.risk_class!.from as string);
  });
});

describe("inferMapping — tenor array detection", () => {
  it("groups tenor_<period> columns into a risk_value array mapping", () => {
    const cols = [
      col("tenor_3M", "NUMERIC"),
      col("tenor_6M", "NUMERIC"),
      col("tenor_1Y", "NUMERIC"),
      col("tenor_2Y", "NUMERIC"),
      col("tenor_5Y", "NUMERIC"),
      col("tenor_10Y", "NUMERIC"),
      col("book"),
    ];
    const m = inferMapping({ schema: fakeSchema(), columns: cols });
    expect(m.fields.risk_value).toBeDefined();
    expect(m.fields.risk_value!.type).toBe("array_number");
    const from = m.fields.risk_value!.from;
    expect(Array.isArray(from)).toBe(true);
    expect(from as string[]).toEqual(["tenor_3M", "tenor_6M", "tenor_1Y", "tenor_2Y", "tenor_5Y", "tenor_10Y"]);
  });

  it("does not group non-numeric tenor-named columns", () => {
    const m = inferMapping({
      schema: fakeSchema(),
      columns: [col("tenor_3M", "TAG"), col("tenor_6M", "TAG")],
    });
    expect(m.fields.risk_value).toBeUndefined();
  });
});

describe("inferMapping — coverage", () => {
  it("hits ≥80% of FRTB binding dimensions on obvious headers", () => {
    const m = inferMapping({
      schema: fakeSchema(),
      columns: [
        col("risk_class"), col("bucket"), col("sensitivity_type"),
        col("tenor"), col("risk_value", "NUMERIC"), col("weight", "NUMERIC"),
      ],
    });
    const bindingKeys = Object.keys(fakeSchema().frtb_binding);
    const mapped = bindingKeys.filter((k) => m.fields[k] !== undefined);
    expect(mapped.length / bindingKeys.length).toBeGreaterThanOrEqual(0.8);
  });
});
