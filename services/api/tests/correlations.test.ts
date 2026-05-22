import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import { buildCrossBucketCorrelations } from "../src/sbm/correlations.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
const SCHEMA = resolve(here, "..", "..", "..", "config", "schema", "frtb-default.yaml");

describe("buildCrossBucketCorrelations", () => {
  it("returns one entry per risk class with the constant γ_bc from schema", () => {
    const schema = loadSchema(SCHEMA);
    const out = buildCrossBucketCorrelations(schema);
    expect(out.GIRR).toEqual({ kind: "constant", value: 0.5 });
    expect(out.EQUITY).toEqual({ kind: "constant", value: 0.15 });
    expect(out.FX).toEqual({ kind: "constant", value: 0.6 });
  });

  it("falls back to {kind:constant, value:0} when ref is missing", () => {
    const fake: any = {
      version: 1,
      dimensions: [],
      risk_classes: { XYZ: { dimensions: [], buckets: { naming: "x", values: [] }, risk_weights_ref: "missing", intra_bucket_correlation_ref: "missing", cross_bucket_correlation_ref: "missing" } },
      frtb_binding: {},
      risk_weights: {},
      correlations: {},
    };
    expect(buildCrossBucketCorrelations(fake).XYZ).toEqual({ kind: "constant", value: 0 });
  });
});
