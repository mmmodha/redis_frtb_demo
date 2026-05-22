import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, validateSchema } from "../src/index.ts";
import type { Schema } from "../src/index.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
const tiny = resolve(here, "fixtures/tiny.yaml");

function clone(s: Schema): Schema {
  return JSON.parse(JSON.stringify(s)) as Schema;
}

describe("validateSchema", () => {
  it("returns no errors for the well-formed tiny fixture", () => {
    const result = validateSchema(loadSchema(tiny));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects an illegal dimension type", () => {
    const s = clone(loadSchema(tiny));
    (s.dimensions[0] as { type: string }).type = "NOT_A_TYPE";
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/risk_class.*NOT_A_TYPE/);
  });

  it("rejects FRTB binding that references a missing dimension", () => {
    const s = clone(loadSchema(tiny));
    s.frtb_binding.weight = "does_not_exist";
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/frtb_binding\.weight.*does_not_exist/);
  });

  it("rejects when all six FRTB binding fields are not present", () => {
    const s = clone(loadSchema(tiny));
    delete (s.frtb_binding as Partial<typeof s.frtb_binding>).tenor;
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/frtb_binding.*tenor/);
  });

  it("rejects a risk class that references a missing risk-weights table", () => {
    const s = clone(loadSchema(tiny));
    s.risk_classes.GIRR!.risk_weights_ref = "nope";
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/GIRR.*risk_weights_ref.*nope/);
  });

  it("rejects a risk class that references missing correlation tables", () => {
    const s = clone(loadSchema(tiny));
    s.risk_classes.GIRR!.intra_bucket_correlation_ref = "missing_rho";
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/GIRR.*intra_bucket_correlation_ref.*missing_rho/);
  });

  it("rejects a risk class whose dimension list references unknown dimensions", () => {
    const s = clone(loadSchema(tiny));
    s.risk_classes.GIRR!.dimensions.push("phantom_field");
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/GIRR.*phantom_field/);
  });

  it("requires at least one dimension with hash_tag_role=primary", () => {
    const s = clone(loadSchema(tiny));
    for (const d of s.dimensions) delete d.hash_tag_role;
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/hash_tag_role/i);
  });

  it("rejects a matrix correlation whose matrix is not square or mismatches labels", () => {
    const s = clone(loadSchema(tiny));
    s.correlations.bad_matrix = {
      kind: "matrix",
      labels: ["A", "B", "C"],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    };
    const result = validateSchema(s);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/bad_matrix/);
  });
});
