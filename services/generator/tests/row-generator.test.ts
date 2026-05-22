import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import { createRowGenerator } from "../src/row-generator.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
const multiClass = resolve(here, "fixtures/multi-class.yaml");
const swapClass = resolve(here, "fixtures/swap-schema.yaml");

let schema: Schema;
let swapSchema: Schema;

beforeAll(() => {
  schema = loadSchema(multiClass);
  swapSchema = loadSchema(swapClass);
});

describe("createRowGenerator (schema-driven, per-risk-class)", () => {
  it("emits GIRR rows with risk_value as a 10-element JSON array (no row explosion)", () => {
    const gen = createRowGenerator(schema, { seed: 1 });
    const row = gen.generate("GIRR");
    expect(Array.isArray(row.risk_value)).toBe(true);
    expect((row.risk_value as number[]).length).toBe(10);
    for (const v of row.risk_value as number[]) {
      expect(typeof v).toBe("number");
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("emits GIRR rows whose tenor matches the schema's tenor.nodes (when ARRAY shape)", () => {
    const gen = createRowGenerator(schema, { seed: 1 });
    const row = gen.generate("GIRR");
    const tenorNodes = schema.risk_classes.GIRR!.tenor!.nodes;
    expect(Array.isArray(row.tenor) ? row.tenor : [row.tenor]).toEqual(tenorNodes);
  });

  it("emits EQUITY rows with scalar risk_value and bucket from the EQUITY bucket scheme", () => {
    const gen = createRowGenerator(schema, { seed: 7 });
    const row = gen.generate("EQUITY");
    expect(typeof row.risk_value).toBe("number");
    expect(schema.risk_classes.EQUITY!.buckets.values).toContain(row.bucket);
    expect(row.issuer).toBeTypeOf("string");
  });

  it("emits FX rows whose bucket comes from the FX bucket-pair list", () => {
    const gen = createRowGenerator(schema, { seed: 13 });
    const row = gen.generate("FX");
    expect(["USDEUR", "USDGBP", "USDJPY"]).toContain(row.bucket);
    expect(typeof row.risk_value).toBe("number");
    expect(row.pair).toBeTypeOf("string");
  });

  it("includes every dimension named in the risk class's dimensions list (and excludes others)", () => {
    const gen = createRowGenerator(schema, { seed: 3 });
    const row = gen.generate("FX");
    const expected = schema.risk_classes.FX!.dimensions;
    for (const dim of expected) expect(row).toHaveProperty(dim);
    // GIRR-only field must NOT appear on FX rows
    expect(row).not.toHaveProperty("desk");
  });

  it("uses physical FRTB binding names — risk_class field carries the FRTB risk-class identifier", () => {
    const gen = createRowGenerator(schema, { seed: 5 });
    expect(gen.generate("GIRR").risk_class).toBe("GIRR");
    expect(gen.generate("EQUITY").risk_class).toBe("EQUITY");
    expect(gen.generate("FX").risk_class).toBe("FX");
  });

  it("stamps each row with _hash_tag = '{risk_class}:{bucket}' so ingest does not have to compute it", () => {
    const gen = createRowGenerator(schema, { seed: 11 });
    const row = gen.generate("GIRR");
    expect(row._hash_tag).toBe(`${row.risk_class}:${row.bucket}`);
  });

  it("stamps each row with a unique _id (ULID)", () => {
    const gen = createRowGenerator(schema, { seed: 1 });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(gen.generate("FX")._id);
    expect(ids.size).toBe(50);
    // ULIDs are 26 chars, Crockford base32
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is deterministic for a given seed — same seed reproduces same rows", () => {
    const a = createRowGenerator(schema, { seed: 42 });
    const b = createRowGenerator(schema, { seed: 42 });
    for (let i = 0; i < 20; i++) {
      const ra = a.generate("EQUITY");
      const rb = b.generate("EQUITY");
      // _id is ULID (time-based, not seed-based) — compare everything else
      const { _id: _a, ...restA } = ra;
      const { _id: _b, ...restB } = rb;
      expect(restA).toEqual(restB);
    }
  });

  it("re-binds to a swapped schema with zero code changes — proves schema-driven contract", () => {
    const gen = createRowGenerator(swapSchema, { seed: 1 });
    const row = gen.generate("FX");
    // swap-schema gives FX a `spread` field and a NUMERIC (not array) risk_value
    expect(typeof row.risk_value).toBe("number");
    expect(row).toHaveProperty("spread");
    expect(typeof row.spread).toBe("number");
    // and removes `pair`-only behaviour — only bucket scheme dictates pair-naming
    expect(["USDEUR", "USDGBP"]).toContain(row.bucket);
  });

  it("throws a descriptive error when asked to generate a risk class the schema does not define", () => {
    const gen = createRowGenerator(swapSchema, { seed: 1 });
    expect(() => gen.generate("GIRR")).toThrow(/GIRR.*not defined|unknown.*risk.*class/i);
  });
});
