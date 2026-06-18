// Wave 6.39.A — distribution modes for the synthetic row generator.
//
// `distribution` selects how a row's bucket is sampled:
//   • undefined (legacy): schema's `bucket_weights` if present, else uniform.
//   • "uniform": every bucket equally likely regardless of schema weights.
//   • "realistic": 5/15/80 split across sparse/medium/dense thirds (FRTB book
//                  shape). Documented in docs/generator-distribution.md.
//   • "pareto":   schema's `bucket_weights` (or uniform when absent).
//
// All four branches MUST consume exactly one rng() tick per bucket pick so
// the rng-isolation canary (existing) keeps holding.

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import { createRowGenerator } from "../src/row-generator.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
let baseSchema: Schema;

beforeAll(() => {
  baseSchema = loadSchema(resolve(here, "fixtures/multi-class.yaml"));
});

function cloneSchema(s: Schema): Schema {
  return JSON.parse(JSON.stringify(s)) as Schema;
}

function histogram(rows: { bucket: string }[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const r of rows) h[r.bucket] = (h[r.bucket] ?? 0) + 1;
  return h;
}

describe("createRowGenerator — distribution=uniform (Wave 6.39.A)", () => {
  it("approximates uniform 1/B per bucket within ±2% at N=10k (3 buckets, GIRR)", () => {
    const gen = createRowGenerator(baseSchema, { seed: 42, distribution: "uniform" });
    const N = 10_000;
    const rows: { bucket: string }[] = new Array(N);
    for (let i = 0; i < N; i++) rows[i] = gen.generate("GIRR");
    const hist = histogram(rows);
    const buckets = baseSchema.risk_classes.GIRR!.buckets.values;
    const expected = 1 / buckets.length;
    for (const b of buckets) {
      const observed = (hist[b] ?? 0) / N;
      expect(Math.abs(observed - expected)).toBeLessThan(0.02);
    }
  });

  it("overrides schema bucket_weights — Pareto-weighted schema still draws uniformly", () => {
    const schema = cloneSchema(baseSchema);
    schema.risk_classes.GIRR!.bucket_weights = { USD: 100, EUR: 0.01, GBP: 0.01 };
    const gen = createRowGenerator(schema, { seed: 7, distribution: "uniform" });
    const N = 5_000;
    const hist: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const b = gen.generate("GIRR").bucket;
      hist[b] = (hist[b] ?? 0) + 1;
    }
    for (const b of ["USD", "EUR", "GBP"]) {
      expect(Math.abs((hist[b] ?? 0) / N - 1 / 3)).toBeLessThan(0.03);
    }
  });
});

describe("createRowGenerator — distribution=realistic (Wave 6.39.A)", () => {
  it("5/15/80 split across sparse/medium/dense thirds (3 buckets → 1 each)", () => {
    const gen = createRowGenerator(baseSchema, { seed: 11, distribution: "realistic" });
    const N = 20_000;
    const hist: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const b = gen.generate("GIRR").bucket;
      hist[b] = (hist[b] ?? 0) + 1;
    }
    const buckets = baseSchema.risk_classes.GIRR!.buckets.values;
    // First third = sparse (5%), middle = medium (15%), last = dense (80%).
    const sparseShare = (hist[buckets[0]!] ?? 0) / N;
    const medShare = (hist[buckets[1]!] ?? 0) / N;
    const denseShare = (hist[buckets[2]!] ?? 0) / N;
    expect(Math.abs(sparseShare - 0.05)).toBeLessThan(0.02);
    expect(Math.abs(medShare - 0.15)).toBeLessThan(0.02);
    expect(Math.abs(denseShare - 0.80)).toBeLessThan(0.02);
  });
});

describe("createRowGenerator — distribution=pareto + default (Wave 6.39.A)", () => {
  it("pareto with schema weights matches the explicit weighted CDF", () => {
    const schema = cloneSchema(baseSchema);
    schema.risk_classes.GIRR!.bucket_weights = { USD: 0.6, EUR: 0.3, GBP: 0.1 };
    const gen = createRowGenerator(schema, { seed: 42, distribution: "pareto" });
    const N = 10_000;
    const hist: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const b = gen.generate("GIRR").bucket;
      hist[b] = (hist[b] ?? 0) + 1;
    }
    expect(Math.abs((hist.USD ?? 0) / N - 0.6)).toBeLessThanOrEqual(0.02);
    expect(Math.abs((hist.EUR ?? 0) / N - 0.3)).toBeLessThanOrEqual(0.02);
    expect(Math.abs((hist.GBP ?? 0) / N - 0.1)).toBeLessThanOrEqual(0.02);
  });

  it("default (undefined) preserves legacy behaviour bit-for-bit — pareto-equivalent", () => {
    // Same seed → same rng sequence → same row tuples. Default path was the
    // schema-aware draw; setting `distribution: "pareto"` must replay the
    // same bucket sequence so existing fixtures don't drift.
    const schema = cloneSchema(baseSchema);
    schema.risk_classes.GIRR!.bucket_weights = { USD: 0.6, EUR: 0.3, GBP: 0.1 };
    const a = createRowGenerator(schema, { seed: 99 });
    const b = createRowGenerator(schema, { seed: 99, distribution: "pareto" });
    for (let i = 0; i < 200; i++) {
      const ra = a.generate("GIRR");
      const rb = b.generate("GIRR");
      expect(rb.bucket).toBe(ra.bucket);
      expect(rb.risk_value).toEqual(ra.risk_value);
    }
  });
});
