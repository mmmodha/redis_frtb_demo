import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, validateSchema, sampleRowFor, RISK_CLASSES } from "../src/index.ts";
import type { RiskClassId } from "../src/index.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../../..");
const defaultPath = resolve(repoRoot, "config/schema/frtb-default.yaml");
const minimalPath = resolve(repoRoot, "config/schema/frtb-minimal.yaml");

describe("config/schema/frtb-default.yaml", () => {
  const schema = loadSchema(defaultPath);

  it("validates cleanly", () => {
    const result = validateSchema(schema);
    expect(result.errors).toEqual([]);
  });

  it("contains all 7 FRTB-SA risk classes", () => {
    for (const rc of RISK_CLASSES) {
      expect(Object.keys(schema.risk_classes)).toContain(rc);
    }
  });

  it("has approximately 110 total dimensions (>= 100, <= 130)", () => {
    expect(schema.dimensions.length).toBeGreaterThanOrEqual(100);
    expect(schema.dimensions.length).toBeLessThanOrEqual(130);
  });

  it("has the FRTB binding fully populated and resolving to real dimensions", () => {
    const names = new Set(schema.dimensions.map((d) => d.name));
    for (const field of [
      "risk_class",
      "bucket",
      "tenor",
      "risk_value",
      "weight",
      "sensitivity_type",
    ] as const) {
      const target = schema.frtb_binding[field];
      expect(names.has(target), `binding ${field} -> ${target}`).toBe(true);
    }
  });

  it("models risk_value as an ARRAY_NUMERIC (tenor curves are JSON arrays — no row explosion)", () => {
    const rv = schema.dimensions.find(
      (d) => d.name === schema.frtb_binding.risk_value,
    );
    expect(rv?.type).toBe("ARRAY_NUMERIC");
  });

  it("has at least one primary hash_tag dimension on risk_class and bucket (for sens:{risk_class}:{bucket}:{ulid})", () => {
    const primaries = schema.dimensions
      .filter((d) => d.hash_tag_role === "primary")
      .map((d) => d.name);
    expect(primaries).toContain(schema.frtb_binding.risk_class);
    expect(primaries).toContain(schema.frtb_binding.bucket);
  });

  it("limits the indexed dimension count to ~10–15 (RQE memory budget)", () => {
    const indexed = schema.dimensions.filter((d) => d.indexed);
    expect(indexed.length).toBeGreaterThanOrEqual(8);
    expect(indexed.length).toBeLessThanOrEqual(20);
  });

  it("produces a complete sample row for every defined risk class", () => {
    for (const rc of Object.keys(schema.risk_classes) as RiskClassId[]) {
      const row = sampleRowFor(rc, schema);
      expect(row.risk_class).toBe(rc);
      expect(row.bucket).toBeTruthy();
      expect(row.sensitivity_type).toBeTruthy();
    }
  });
});

describe("config/schema/frtb-minimal.yaml", () => {
  const schema = loadSchema(minimalPath);

  it("validates cleanly", () => {
    const result = validateSchema(schema);
    expect(result.errors).toEqual([]);
  });

  it("is deliberately a different shape from frtb-default.yaml (proves swap works)", () => {
    const def = loadSchema(defaultPath);
    expect(schema.dimensions.length).toBeLessThan(def.dimensions.length);
    const defBuckets = def.risk_classes.GIRR?.buckets.values ?? [];
    const minBuckets = schema.risk_classes.GIRR?.buckets.values ?? [];
    expect(minBuckets).not.toEqual(defBuckets);
  });
});
