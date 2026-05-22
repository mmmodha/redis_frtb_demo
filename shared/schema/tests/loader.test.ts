import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "../src/index.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
const tiny = resolve(here, "fixtures/tiny.yaml");

describe("loadSchema", () => {
  it("parses a YAML file and returns a Schema with version + dimensions", () => {
    const schema = loadSchema(tiny);
    expect(schema.version).toBe(1);
    expect(schema.dimensions).toHaveLength(6);
    expect(schema.dimensions[0]).toEqual({
      name: "risk_class",
      type: "TAG",
      indexed: true,
      sortable: false,
      hash_tag_role: "primary",
    });
  });

  it("exposes risk classes keyed by name", () => {
    const schema = loadSchema(tiny);
    expect(Object.keys(schema.risk_classes)).toContain("GIRR");
    const girr = schema.risk_classes.GIRR!;
    expect(girr.buckets.values).toEqual(["USD", "EUR", "GBP"]);
    expect(girr.tenor!.nodes).toEqual(["3M", "6M", "1Y"]);
  });

  it("exposes the FRTB binding block", () => {
    const schema = loadSchema(tiny);
    expect(schema.frtb_binding.risk_class).toBe("risk_class");
    expect(schema.frtb_binding.risk_value).toBe("risk_value");
  });

  it("throws a descriptive error when the file does not exist", () => {
    expect(() => loadSchema("/no/such/file.yaml")).toThrow(/schema file not found/i);
  });

  it("throws when the YAML is missing required top-level keys", () => {
    expect(() => loadSchema(resolve(here, "fixtures/empty.yaml"))).toThrow(
      /version|dimensions|frtb_binding/i
    );
  });
});
