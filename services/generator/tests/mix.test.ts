import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import { pickRiskClasses } from "../src/mix.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
let schema: Schema;
beforeAll(() => {
  schema = loadSchema(resolve(here, "fixtures/multi-class.yaml"));
});

describe("pickRiskClasses (CLI --classes resolution)", () => {
  it("expands 'all' to every risk class defined in the schema", () => {
    const out = pickRiskClasses(schema, "all");
    expect(out.sort()).toEqual(["EQUITY", "FX", "GIRR"].sort());
  });

  it("accepts a comma-separated list (case-insensitive)", () => {
    const out = pickRiskClasses(schema, "girr,fx");
    expect(out.sort()).toEqual(["FX", "GIRR"].sort());
  });

  it("rejects unknown risk classes with a descriptive error", () => {
    expect(() => pickRiskClasses(schema, "girr,unicorns")).toThrow(/unicorns/i);
  });

  it("rejects an empty selection", () => {
    expect(() => pickRiskClasses(schema, "")).toThrow(/empty|no risk classes/i);
  });
});
