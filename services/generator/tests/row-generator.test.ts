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

// Wave 5.16d — Curvature row shape (shape A per docs/demo/curvature-scope.md
// §3a). Generator emits Curvature rows when sensitivityTypes is overridden to
// include "Curvature"; default behaviour (["Delta","Vega"]) stays intact above.
describe("createRowGenerator — Curvature shape A (Wave 5.16d)", () => {
  it("emits GIRR Curvature rows with risk_value = { cvr_up: number[T], cvr_down: number[T] }", () => {
    const gen = createRowGenerator(schema, { seed: 1, sensitivityTypes: ["Curvature"] });
    const tenorNodes = schema.risk_classes.GIRR!.tenor!.nodes;
    for (let i = 0; i < 25; i++) {
      const row = gen.generate("GIRR");
      expect(row.sensitivity_type).toBe("Curvature");
      const rv = row.risk_value as { cvr_up: number[]; cvr_down: number[] };
      expect(rv).toBeTypeOf("object");
      expect(Array.isArray(rv.cvr_up)).toBe(true);
      expect(Array.isArray(rv.cvr_down)).toBe(true);
      expect(rv.cvr_up.length).toBe(tenorNodes.length);
      expect(rv.cvr_down.length).toBe(tenorNodes.length);
      for (const v of rv.cvr_up) {
        expect(typeof v).toBe("number");
        expect(Number.isFinite(v)).toBe(true);
      }
      for (const v of rv.cvr_down) {
        expect(typeof v).toBe("number");
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("emits EQUITY Curvature rows with scalar { cvr_up: number, cvr_down: number }", () => {
    const gen = createRowGenerator(schema, { seed: 7, sensitivityTypes: ["Curvature"] });
    for (let i = 0; i < 20; i++) {
      const row = gen.generate("EQUITY");
      expect(row.sensitivity_type).toBe("Curvature");
      const rv = row.risk_value as { cvr_up: number; cvr_down: number };
      expect(rv).toBeTypeOf("object");
      expect(typeof rv.cvr_up).toBe("number");
      expect(typeof rv.cvr_down).toBe("number");
      expect(Number.isFinite(rv.cvr_up)).toBe(true);
      expect(Number.isFinite(rv.cvr_down)).toBe(true);
      expect(schema.risk_classes.EQUITY!.buckets.values).toContain(row.bucket);
    }
  });

  it("emits FX Curvature rows with scalar { cvr_up: number, cvr_down: number }", () => {
    const gen = createRowGenerator(schema, { seed: 13, sensitivityTypes: ["Curvature"] });
    for (let i = 0; i < 20; i++) {
      const row = gen.generate("FX");
      expect(row.sensitivity_type).toBe("Curvature");
      const rv = row.risk_value as { cvr_up: number; cvr_down: number };
      expect(typeof rv.cvr_up).toBe("number");
      expect(typeof rv.cvr_down).toBe("number");
      expect(["USDEUR", "USDGBP", "USDJPY"]).toContain(row.bucket);
    }
  });

  it("Curvature CVR magnitudes are within the documented ranges (cvr_up ∈ [-5,+10], cvr_down ∈ [-10,+5]) and include mixed signs", () => {
    const gen = createRowGenerator(schema, { seed: 23, sensitivityTypes: ["Curvature"] });
    let upPositives = 0, upNegatives = 0;
    let downPositives = 0, downNegatives = 0;
    for (let i = 0; i < 200; i++) {
      const row = gen.generate("GIRR");
      const rv = row.risk_value as { cvr_up: number[]; cvr_down: number[] };
      for (const v of rv.cvr_up) {
        expect(v).toBeGreaterThanOrEqual(-5);
        expect(v).toBeLessThanOrEqual(10);
        if (v > 0) upPositives++; else if (v < 0) upNegatives++;
      }
      for (const v of rv.cvr_down) {
        expect(v).toBeGreaterThanOrEqual(-10);
        expect(v).toBeLessThanOrEqual(5);
        if (v > 0) downPositives++; else if (v < 0) downNegatives++;
      }
    }
    // Mixed-sign sanity — every quadrant populated so cross-bucket math
    // (ψ-gate, K_b^+ vs K_b^-) actually exercises on synthetic fixtures.
    expect(upPositives).toBeGreaterThan(0);
    expect(upNegatives).toBeGreaterThan(0);
    expect(downPositives).toBeGreaterThan(0);
    expect(downNegatives).toBeGreaterThan(0);
  });

  it("ratio honoured: passing a mixed sensitivityTypes list emits all values with roughly the requested frequency", () => {
    const gen = createRowGenerator(schema, { seed: 99, sensitivityTypes: ["Delta", "Vega", "Curvature"] });
    const counts: Record<string, number> = { Delta: 0, Vega: 0, Curvature: 0 };
    for (let i = 0; i < 600; i++) {
      const row = gen.generate("GIRR");
      const s = String(row.sensitivity_type);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    // Each ≥ 100 / 600 (uniform pick from 3 options ≈ 200 each — wide tolerance).
    expect(counts.Delta).toBeGreaterThan(100);
    expect(counts.Vega).toBeGreaterThan(100);
    expect(counts.Curvature).toBeGreaterThan(100);
    expect(counts.Delta! + counts.Vega! + counts.Curvature!).toBe(600);
  });

  it("Curvature rows spread across multiple buckets (per-bucket distribution sensible, not single-bucket)", () => {
    const gen = createRowGenerator(schema, { seed: 41, sensitivityTypes: ["Curvature"] });
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(String(gen.generate("GIRR").bucket));
    // GIRR has 3 buckets in the fixture (USD, EUR, GBP) — all three should
    // appear within 100 draws with the uniform-pick implementation.
    expect(seen.size).toBe(schema.risk_classes.GIRR!.buckets.values.length);
  });

  it("Curvature row keeps the _hash_tag = '{risk_class}:{bucket}' contract used by ingest routing", () => {
    const gen = createRowGenerator(schema, { seed: 17, sensitivityTypes: ["Curvature"] });
    const row = gen.generate("GIRR");
    expect(row._hash_tag).toBe(`${row.risk_class}:${row.bucket}`);
    expect(row.sensitivity_type).toBe("Curvature");
  });

  it("default sensitivityTypes (Delta/Vega) never emits Curvature — preserves pre-5.16d behaviour", () => {
    const gen = createRowGenerator(schema, { seed: 5 });
    for (let i = 0; i < 200; i++) {
      const row = gen.generate("GIRR");
      expect(row.sensitivity_type).not.toBe("Curvature");
      // And risk_value stays the legacy array shape (NOT { cvr_up, cvr_down }).
      expect(Array.isArray(row.risk_value)).toBe(true);
    }
  });
});
