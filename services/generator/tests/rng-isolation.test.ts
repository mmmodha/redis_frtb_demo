// Wave 5.17a — Byte-equivalence harness for the HSBC reshape.
//
// Proves DoD #2: a seeded row-generator run reproduces the same numeric
// `risk_value` payload across two configurations of the new aux-RNG fields
// (trade_pool_size / factor_pool_size). The reshape changes only the
// *container* of the numbers (array → object, scalar → { spot }); the
// underlying floating-point values must be bit-identical because the main
// value-RNG sequence is never touched by the new HSBC field draws.
//
// This is the unit-level proxy for the smoke-run-16 invariant: if every
// pre-reshape risk_value number reproduces post-reshape, every K_b / S_b
// downstream is byte-equal, and every per-variant charge in the
// smoke-run-16 aggregate is byte-equal.

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import { createRowGenerator } from "../src/row-generator.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
let schema: Schema;

beforeAll(() => {
  schema = loadSchema(resolve(here, "fixtures/multi-class.yaml"));
});

// Flatten the per-(class × sens_type) risk_value object into an ordered
// number array so two generator outputs can be compared element-wise.
function flattenRv(rv: unknown): number[] {
  if (typeof rv === "number") return [rv];
  if (Array.isArray(rv)) return rv as number[];
  if (rv && typeof rv === "object") {
    const obj = rv as Record<string, unknown>;
    // Curvature: { cvr_up, cvr_down }
    if ("cvr_up" in obj && "cvr_down" in obj) {
      const up = obj.cvr_up;
      const down = obj.cvr_down;
      const upArr = Array.isArray(up) ? (up as number[]) : [up as number];
      const downArr = Array.isArray(down) ? (down as number[]) : [down as number];
      return [...upArr, ...downArr];
    }
    // { spot }
    if ("spot" in obj) return [obj.spot as number];
    // Per-tenor object — sort keys deterministically (test-only flattener).
    return Object.keys(obj).sort().map((k) => obj[k] as number);
  }
  return [];
}

describe("RNG isolation — aux RNG must not perturb the value-RNG sequence", () => {
  it("two configurations with different trade/factor pool sizes produce IDENTICAL numeric risk_value payloads (seed=0)", () => {
    const a = createRowGenerator(schema, { seed: 0 });
    const b = createRowGenerator(schema, { seed: 0, tradePoolSize: 17, factorPoolSize: 7 });
    const classes = ["GIRR", "EQUITY", "FX"] as const;
    for (let i = 0; i < 600; i++) {
      const cls = classes[i % classes.length]!;
      const ra = a.generate(cls);
      const rb = b.generate(cls);
      expect(flattenRv(rb.risk_value)).toEqual(flattenRv(ra.risk_value));
    }
  });

  it("Curvature draws are also bit-stable under aux-RNG config changes (seed=0)", () => {
    const a = createRowGenerator(schema, { seed: 0, sensitivityTypes: ["Curvature"] });
    const b = createRowGenerator(schema, {
      seed: 0,
      sensitivityTypes: ["Curvature"],
      tradePoolSize: 999,
      factorPoolSize: 32,
    });
    const classes = ["GIRR", "EQUITY", "FX"] as const;
    for (let i = 0; i < 300; i++) {
      const cls = classes[i % classes.length]!;
      const ra = a.generate(cls);
      const rb = b.generate(cls);
      expect(flattenRv(rb.risk_value)).toEqual(flattenRv(ra.risk_value));
    }
  });

  it("trade_id always matches /^T\\d{4,}$/ and risk_factor matches /^RF_[A-Z0-9_]+$/", () => {
    const gen = createRowGenerator(schema, { seed: 7 });
    const classes = ["GIRR", "EQUITY", "FX"] as const;
    for (let i = 0; i < 120; i++) {
      const row = gen.generate(classes[i % classes.length]!);
      expect(String(row.trade_id)).toMatch(/^T\d{4,}$/);
      expect(String(row.risk_factor)).toMatch(/^RF_[A-Z0-9_]+$/);
    }
  });

  it("pool sizes are honoured: distinct trade_id values ≤ pool size", () => {
    const gen = createRowGenerator(schema, { seed: 0, tradePoolSize: 5 });
    const tradeIds = new Set<string>();
    for (let i = 0; i < 200; i++) tradeIds.add(String(gen.generate("GIRR").trade_id));
    expect(tradeIds.size).toBeLessThanOrEqual(5);
    expect(tradeIds.size).toBeGreaterThan(0);
  });
});
