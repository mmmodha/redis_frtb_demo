import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import { createRowGenerator, computeCoverageQuotas } from "../src/row-generator.ts";

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
  it("emits GIRR rows with risk_value as a sparse per-tenor JSON object (Wave 5.52 — K∈[5..10] tenors per row)", () => {
    const gen = createRowGenerator(schema, { seed: 1 });
    const tenorNodes = schema.risk_classes.GIRR!.tenor!.nodes;
    const tenorSet = new Set(tenorNodes);
    const seenLengths = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const row = gen.generate("GIRR");
      const rv = row.risk_value as Record<string, number>;
      expect(rv).toBeTypeOf("object");
      expect(Array.isArray(rv)).toBe(false);
      const keys = Object.keys(rv);
      expect(keys.length).toBeGreaterThanOrEqual(5);
      expect(keys.length).toBeLessThanOrEqual(10);
      seenLengths.add(keys.length);
      for (const k of keys) {
        expect(tenorSet.has(k)).toBe(true);
        expect(typeof rv[k]).toBe("number");
        expect(Number.isFinite(rv[k])).toBe(true);
      }
      // Declared tenor order is preserved in the emitted keys.
      const expectedOrder = tenorNodes.filter((t) => t in rv);
      expect(keys).toEqual(expectedOrder);
    }
    // Across 200 rows the K-draw should cover the full [5..10] range.
    expect(seenLengths.size).toBeGreaterThan(1);
  });

  it("emits GIRR rows whose tenor matches the schema's tenor.nodes (when ARRAY shape)", () => {
    const gen = createRowGenerator(schema, { seed: 1 });
    const row = gen.generate("GIRR");
    const tenorNodes = schema.risk_classes.GIRR!.tenor!.nodes;
    expect(Array.isArray(row.tenor) ? row.tenor : [row.tenor]).toEqual(tenorNodes);
  });

  it("emits EQUITY rows with { spot } risk_value object and bucket from the EQUITY bucket scheme", () => {
    const gen = createRowGenerator(schema, { seed: 7 });
    const row = gen.generate("EQUITY");
    const rv = row.risk_value as { spot: number };
    expect(rv).toBeTypeOf("object");
    expect(typeof rv.spot).toBe("number");
    expect(Number.isFinite(rv.spot)).toBe(true);
    expect(schema.risk_classes.EQUITY!.buckets.values).toContain(row.bucket);
    expect(row.issuer).toBeTypeOf("string");
  });

  it("emits FX rows whose bucket comes from the FX bucket-pair list and risk_value is { spot }", () => {
    const gen = createRowGenerator(schema, { seed: 13 });
    const row = gen.generate("FX");
    expect(["USDEUR", "USDGBP", "USDJPY"]).toContain(row.bucket);
    const rv = row.risk_value as { spot: number };
    expect(rv).toBeTypeOf("object");
    expect(typeof rv.spot).toBe("number");
    expect(row.pair).toBeTypeOf("string");
  });

  it("emits tenant trade_id (T0001-style) and risk_factor (RF_<CLASS>_NN) on every row [Wave 5.17a]", () => {
    const gen = createRowGenerator(schema, { seed: 5 });
    for (const cls of ["GIRR", "EQUITY", "FX"] as const) {
      const row = gen.generate(cls);
      expect(String(row.trade_id)).toMatch(/^T\d{4,}$/);
      expect(String(row.risk_factor)).toMatch(/^RF_(GIRR|EQUITY|FX)_[A-Z0-9_]+$/);
    }
  });

  it("aux-RNG isolation: changing trade_pool_size / factor_pool_size does NOT shift risk_value numbers [Wave 5.17a]", () => {
    const a = createRowGenerator(schema, { seed: 99 });
    const b = createRowGenerator(schema, { seed: 99, tradePoolSize: 1, factorPoolSize: 1 });
    for (let i = 0; i < 30; i++) {
      const ra = a.generate("GIRR");
      const rb = b.generate("GIRR");
      // risk_value, weight, bucket, sensitivity_type must all be identical —
      // only trade_id / risk_factor may differ because they draw from a
      // separate aux RNG seeded with `<seed>:aux`.
      expect(rb.risk_value).toEqual(ra.risk_value);
      expect(rb.bucket).toEqual(ra.bucket);
      expect(rb.sensitivity_type).toEqual(ra.sensitivity_type);
      expect(rb.weight).toEqual(ra.weight);
    }
  });

  it("includes every dimension named in the risk class's dimensions list (and excludes others)", () => {
    const gen = createRowGenerator(schema, { seed: 3 });
    const row = gen.generate("FX");
    const expected = schema.risk_classes.FX!.dimensions;
    for (const dim of expected) expect(row).toHaveProperty(dim);
    // GIRR-only schema field must NOT appear on FX rows
    expect(row).not.toHaveProperty("issuer");
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
    // Wave 5.17a — swap-schema's NUMERIC risk_value is now wrapped as { spot }.
    const rv = row.risk_value as { spot: number };
    expect(rv).toBeTypeOf("object");
    expect(typeof rv.spot).toBe("number");
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

  // Wave 7.0.6.19 — sensitivity_type coverage floor. Guarantees every
  // (risk_class, sensitivity_type) combo gets at least `coverageFloor`
  // emissions per class before reverting to uniform-random. Closes the
  // verifier-Step-6 gap where a 50k bulk run could emit ZERO GIRR Curvature
  // rows because the uniform pick missed it. Default (undefined / 0)
  // preserves the legacy single-rng()-tick pick (rng-isolation canary holds).
  describe("coverage floor (Wave 7.0.6.19)", () => {
    it("rows=200 across 3 classes round-robin contains ≥1 GIRR Curvature row when floor=2", () => {
      // Mirrors POST /ingest/bulk/start computeCoverageFloor(200, 1) = 2.
      const gen = createRowGenerator(schema, {
        seed: "rows-200",
        sensitivityTypes: ["Delta", "Vega", "Curvature"],
        coverageFloor: 2,
      });
      const classes = ["GIRR", "EQUITY", "FX"] as const;
      let girrCurvature = 0;
      for (let i = 0; i < 200; i++) {
        const row = gen.generate(classes[i % classes.length]!);
        if (row.risk_class === "GIRR" && row.sensitivity_type === "Curvature") girrCurvature++;
      }
      // Floor=2 means GIRR sees Curvature at least twice; ingest verifier
      // only needs ≥1 to gate Step 6 as charge>0.
      expect(girrCurvature).toBeGreaterThanOrEqual(2);
    });

    it("every (risk_class, sensitivity_type) combo meets the floor across 3 classes", () => {
      const gen = createRowGenerator(schema, {
        seed: "floor-all",
        sensitivityTypes: ["Delta", "Vega", "Curvature"],
        coverageFloor: 3,
      });
      const classes = ["GIRR", "EQUITY", "FX"] as const;
      const counts: Record<string, number> = {};
      for (let i = 0; i < 300; i++) {
        const row = gen.generate(classes[i % classes.length]!);
        const key = `${row.risk_class}|${row.sensitivity_type}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      for (const cls of classes) {
        for (const st of ["Delta", "Vega", "Curvature"]) {
          expect(counts[`${cls}|${st}`] ?? 0).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it("floor consumes one rng() tick per row — risk_value sequence matches a no-floor run with the same seed for the first floor*sensTypes rows when forced indices align with the uniform pick", () => {
      // Sanity: floor changes sens_type pick but does NOT shift the
      // downstream rng() ticks (bucket / risk_value / weights). For a
      // single-class run with floor and N rows, the bucket sequence equals
      // the no-floor run because both consume one tick before the sens_type
      // pick and one after.
      const a = createRowGenerator(schema, { seed: "tick", sensitivityTypes: ["Delta"], coverageFloor: 5 });
      const b = createRowGenerator(schema, { seed: "tick", sensitivityTypes: ["Delta"] });
      for (let i = 0; i < 50; i++) {
        const ra = a.generate("GIRR");
        const rb = b.generate("GIRR");
        expect(ra.bucket).toBe(rb.bucket);
        expect(ra.risk_value).toEqual(rb.risk_value);
      }
    });

    it("coverageFloor undefined / 0 preserves legacy uniform pick (rng-isolation canary holds)", () => {
      const a = createRowGenerator(schema, { seed: "legacy", sensitivityTypes: ["Delta", "Vega", "Curvature"] });
      const b = createRowGenerator(schema, { seed: "legacy", sensitivityTypes: ["Delta", "Vega", "Curvature"], coverageFloor: 0 });
      for (let i = 0; i < 60; i++) {
        const ra = a.generate("GIRR");
        const rb = b.generate("GIRR");
        expect(rb.sensitivity_type).toBe(ra.sensitivity_type);
        expect(rb.bucket).toBe(ra.bucket);
        expect(rb.risk_value).toEqual(ra.risk_value);
      }
    });
  });

  // Wave 7.0.6.20 — reallocation-based coverage floor. The 6.19 bias-on-pick
  // path forced the first `floor` rows of each (rc, sens_type) regardless of
  // the planned per-class row count, which could let the floor effectively
  // inflate the row mix when multiplied across (classes × sens_types) on a
  // small per-worker slice. The 6.20 path pre-computes a per-(rc, sens_type)
  // quota table that sums EXACTLY to the planned per-class row count, so the
  // overall row total is preserved within ±num_combos (integer rounding).
  describe("coverage floor reallocation (Wave 7.0.6.20)", () => {
    // Helper — drive the generator round-robin across `classes` for the
    // planned per-class counts and return the (rc, sens_type) histogram.
    function runPlanned(opts: {
      seed: string | number;
      sensTypes: readonly string[];
      coverageFloor: number;
      classes: readonly string[];
      offset: number;
      stride: number;
      rowsTotal: number;
    }): { hist: Record<string, number>; rowsEmitted: number; plannedRowsByClass: Record<string, number> } {
      const plannedRowsByClass: Record<string, number> = {};
      for (const c of opts.classes) plannedRowsByClass[c] = 0;
      for (let i = opts.offset; i < opts.rowsTotal; i += opts.stride) {
        plannedRowsByClass[opts.classes[i % opts.classes.length]!]!++;
      }
      const gen = createRowGenerator(schema, {
        seed: opts.seed,
        sensitivityTypes: [...opts.sensTypes],
        coverageFloor: opts.coverageFloor,
        plannedRowsByClass,
      });
      const hist: Record<string, number> = {};
      let rowsEmitted = 0;
      for (let i = opts.offset; i < opts.rowsTotal; i += opts.stride) {
        const row = gen.generate(opts.classes[i % opts.classes.length]!);
        const key = `${row.risk_class}|${row.sensitivity_type}`;
        hist[key] = (hist[key] ?? 0) + 1;
        rowsEmitted++;
      }
      return { hist, rowsEmitted, plannedRowsByClass };
    }

    it("computeCoverageQuotas sums to plannedRows exactly and meets the floor (or capped floor when plannedRows < n*floor)", () => {
      // Realistic 1M-row / 3-combo case: uniform split already exceeds the
      // floor — reallocation is a no-op; sum matches plannedRows exactly.
      const big = computeCoverageQuotas(333_334, 3, 10_000);
      expect(big.reduce((a, b) => a + b, 0)).toBe(333_334);
      for (const q of big) expect(q).toBeGreaterThanOrEqual(10_000);
      // Small smoke case: rows=66, n=3, floor=20 → effFloor=min(20, 22)=20.
      // Base uniform = [22,22,22]; nothing to reallocate; floor met.
      const small = computeCoverageQuotas(66, 3, 20);
      expect(small.reduce((a, b) => a + b, 0)).toBe(66);
      for (const q of small) expect(q).toBeGreaterThanOrEqual(20);
      // Sub-min-floor case: rows=10, n=3, floor=5 → effFloor=min(5, 3)=3.
      // Caller asked for 5 per combo but only 10 rows available, so we
      // settle for floor(10/3)=3 and PRESERVE the total of 10.
      const tiny = computeCoverageQuotas(10, 3, 5);
      expect(tiny.reduce((a, b) => a + b, 0)).toBe(10);
      for (const q of tiny) expect(q).toBeGreaterThanOrEqual(3);
    });

    it("small-run preserves GIRR Curvature guarantee AND total within ±num_combos (rows=200, 3 classes × 3 sens-types)", () => {
      // Mirrors POST /ingest/bulk/start rows=200 with coverageFloor=2.
      const sensTypes = ["Delta", "Vega", "Curvature"] as const;
      const classes = ["GIRR", "EQUITY", "FX"] as const;
      const { hist, rowsEmitted, plannedRowsByClass } = runPlanned({
        seed: "realloc-200",
        sensTypes,
        coverageFloor: 2,
        classes,
        offset: 0,
        stride: 1,
        rowsTotal: 200,
      });
      // Total emitted == requested EXACTLY (reallocation, not addition).
      expect(rowsEmitted).toBe(200);
      const total = Object.values(hist).reduce((a, b) => a + b, 0);
      expect(total).toBe(200);
      // Per-class sum matches the planned per-class row count exactly.
      for (const cls of classes) {
        let perClass = 0;
        for (const st of sensTypes) perClass += hist[`${cls}|${st}`] ?? 0;
        expect(perClass).toBe(plannedRowsByClass[cls]);
      }
      // GIRR Curvature preserved (≥ floor since the natural share also meets it).
      expect(hist["GIRR|Curvature"] ?? 0).toBeGreaterThanOrEqual(2);
    });

    it("medium run rows=1000 across 3 classes × 3 sens-types: actual == requested exactly (tolerance ±num_combos = 9)", () => {
      const { rowsEmitted } = runPlanned({
        seed: "realloc-1k",
        sensTypes: ["Delta", "Vega", "Curvature"],
        coverageFloor: 10,
        classes: ["GIRR", "EQUITY", "FX"],
        offset: 0,
        stride: 1,
        rowsTotal: 1000,
      });
      expect(Math.abs(rowsEmitted - 1000)).toBeLessThanOrEqual(9);
      // Stronger: per-class quotas sum to plannedRows exactly, so the only
      // way rowsEmitted ≠ rowsTotal is if the round-robin doesn't cover all
      // rows (it does for stride=1).
      expect(rowsEmitted).toBe(1000);
    });

    it("large run rows=1,000,000 across 3 classes × 3 sens-types: actual within ±9 of requested", () => {
      const { rowsEmitted } = runPlanned({
        seed: "realloc-1M",
        sensTypes: ["Delta", "Vega", "Curvature"],
        coverageFloor: 10_000,
        classes: ["GIRR", "EQUITY", "FX"],
        offset: 0,
        stride: 1,
        rowsTotal: 1_000_000,
      });
      expect(Math.abs(rowsEmitted - 1_000_000)).toBeLessThanOrEqual(9);
      expect(rowsEmitted).toBe(1_000_000);
    });

    it("multi-worker rows=1,000,000 split across 24 workers: sum of per-worker emissions == requested exactly", () => {
      const totalRows = 1_000_000;
      const workers = 24;
      const sensTypes = ["Delta", "Vega", "Curvature"] as const;
      const classes = ["GIRR", "EQUITY", "FX"] as const;
      // computeCoverageFloor(1M, 24) = ceil(10_000 / 24) = 417.
      const perWorkerCoverageFloor = 417;
      let sumRows = 0;
      for (let w = 0; w < workers; w++) {
        const { rowsEmitted } = runPlanned({
          seed: `realloc-mw:w${w}`,
          sensTypes,
          coverageFloor: perWorkerCoverageFloor,
          classes,
          offset: w,
          stride: workers,
          rowsTotal: totalRows,
        });
        sumRows += rowsEmitted;
      }
      // Per-worker quotas sum to per-worker plannedRows exactly, and per-
      // worker plannedRows sum to totalRows (the stride loop covers every i
      // ∈ [0, totalRows) exactly once across w ∈ [0, workers)).
      expect(sumRows).toBe(totalRows);
    });

    it("same seed → same per-(rc, sens_type) distribution within ±1 (rng-isolation canary preserved across the floor path)", () => {
      const sensTypes = ["Delta", "Vega", "Curvature"] as const;
      const classes = ["GIRR", "EQUITY", "FX"] as const;
      const a = runPlanned({
        seed: "realloc-canary",
        sensTypes,
        coverageFloor: 50,
        classes,
        offset: 0,
        stride: 1,
        rowsTotal: 5_000,
      });
      const b = runPlanned({
        seed: "realloc-canary",
        sensTypes,
        coverageFloor: 50,
        classes,
        offset: 0,
        stride: 1,
        rowsTotal: 5_000,
      });
      // Deterministic — identical seeds and quotas yield identical pick
      // sequences. Allow ±1 only as a safety margin; in practice should be 0.
      for (const cls of classes) {
        for (const st of sensTypes) {
          const key = `${cls}|${st}`;
          expect(Math.abs((a.hist[key] ?? 0) - (b.hist[key] ?? 0))).toBeLessThanOrEqual(1);
        }
      }
    });

    it("legacy bias-on-pick (no plannedRowsByClass) still satisfies the floor guarantee — back-compat for callers not yet migrated", () => {
      // The 6.19 path stays as a fallback when plannedRowsByClass is absent.
      const gen = createRowGenerator(schema, {
        seed: "back-compat",
        sensitivityTypes: ["Delta", "Vega", "Curvature"],
        coverageFloor: 3,
      });
      const classes = ["GIRR", "EQUITY", "FX"] as const;
      const counts: Record<string, number> = {};
      for (let i = 0; i < 300; i++) {
        const row = gen.generate(classes[i % classes.length]!);
        const key = `${row.risk_class}|${row.sensitivity_type}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      for (const cls of classes) {
        for (const st of ["Delta", "Vega", "Curvature"]) {
          expect(counts[`${cls}|${st}`] ?? 0).toBeGreaterThanOrEqual(3);
        }
      }
    });
  });

  it("default sensitivityTypes (Delta/Vega) never emits Curvature — preserves pre-5.16d behaviour", () => {
    const gen = createRowGenerator(schema, { seed: 5 });
    for (let i = 0; i < 200; i++) {
      const row = gen.generate("GIRR");
      expect(row.sensitivity_type).not.toBe("Curvature");
      // Wave 5.17a — Delta/Vega risk_value is now a per-tenor object (NOT
      // `{ cvr_up, cvr_down }` Curvature shape). Verify the per-tenor object
      // form rather than the legacy array form.
      const rv = row.risk_value as Record<string, unknown>;
      expect(rv).toBeTypeOf("object");
      expect(Array.isArray(rv)).toBe(false);
      expect((rv as { cvr_up?: unknown }).cvr_up).toBeUndefined();
    }
  });
});
