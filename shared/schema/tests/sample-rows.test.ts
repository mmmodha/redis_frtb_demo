import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, sampleRowFor } from "../src/index.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
const tiny = resolve(here, "fixtures/tiny.yaml");

describe("sampleRowFor", () => {
  it("produces a row carrying every FRTB-bound field for the requested risk class", () => {
    const schema = loadSchema(tiny);
    const row = sampleRowFor("GIRR", schema);
    expect(row.risk_class).toBe("GIRR");
    expect(typeof row.bucket).toBe("string");
    expect(row.bucket.length).toBeGreaterThan(0);
    expect(["DELTA", "VEGA", "CURVATURE"]).toContain(row.sensitivity_type);
  });

  it("uses a per-tenor object for risk_value when the bound dimension is ARRAY_NUMERIC [Wave 5.17a]", () => {
    const schema = loadSchema(tiny);
    const row = sampleRowFor("GIRR", schema);
    const rv = row.risk_value as Record<string, number>;
    expect(rv).toBeTypeOf("object");
    expect(Array.isArray(rv)).toBe(false);
    const tenorNodes = schema.risk_classes.GIRR!.tenor!.nodes;
    expect(Object.keys(rv).sort()).toEqual([...tenorNodes].sort());
    for (const t of tenorNodes) expect(typeof rv[t]).toBe("number");
  });

  it("picks the bucket value from the configured bucket list", () => {
    const schema = loadSchema(tiny);
    const row = sampleRowFor("GIRR", schema);
    expect(schema.risk_classes.GIRR!.buckets.values).toContain(row.bucket);
  });

  it("throws when asked for a risk class not present in the schema", () => {
    const schema = loadSchema(tiny);
    expect(() => sampleRowFor("EQUITY" as never, schema)).toThrow(
      /risk class EQUITY not defined/i,
    );
  });
});
