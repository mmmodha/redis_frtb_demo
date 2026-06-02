// Wave 5.47a — schema-aware bucket weights.
//
// Asserts the row generator honours the per-class `bucket_weights` map
// (when present) and otherwise falls back to a uniform draw, preserving
// the rng-isolation byte-equivalence already guarded by row-generator.test.ts
// and rng-isolation.test.ts.

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

// Deep-clone the loaded schema so per-test bucket_weights mutations don't
// leak across cases (the loader returns the parsed YAML object as-is).
function cloneSchema(s: Schema): Schema {
  return JSON.parse(JSON.stringify(s)) as Schema;
}

function histogram(rows: { bucket: string }[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const r of rows) h[r.bucket] = (h[r.bucket] ?? 0) + 1;
  return h;
}

describe("createRowGenerator — schema-aware bucket weights (Wave 5.47a)", () => {
  it("approximates declared weights within ±2% at N=10k draws (GIRR, fixed seed)", () => {
    const schema = cloneSchema(baseSchema);
    // GIRR fixture has 3 buckets; declare a non-uniform mix.
    const weights = { USD: 0.6, EUR: 0.3, GBP: 0.1 };
    schema.risk_classes.GIRR!.bucket_weights = weights;
    const gen = createRowGenerator(schema, { seed: 42 });
    const N = 10_000;
    const rows: { bucket: string }[] = new Array(N);
    for (let i = 0; i < N; i++) rows[i] = gen.generate("GIRR");
    const hist = histogram(rows);
    for (const [b, w] of Object.entries(weights)) {
      const observed = (hist[b] ?? 0) / N;
      expect(Math.abs(observed - w)).toBeLessThanOrEqual(0.02);
    }
  });

  it("zero-weighted bucket NEVER appears across N=5k draws", () => {
    const schema = cloneSchema(baseSchema);
    schema.risk_classes.GIRR!.bucket_weights = { USD: 0.5, EUR: 0.5, GBP: 0 };
    const gen = createRowGenerator(schema, { seed: 7 });
    for (let i = 0; i < 5_000; i++) {
      expect(gen.generate("GIRR").bucket).not.toBe("GBP");
    }
  });

  it("absent bucket in the map is treated as weight 0 (never sampled)", () => {
    const schema = cloneSchema(baseSchema);
    // Omit GBP from the weights map entirely — must still never be drawn.
    schema.risk_classes.GIRR!.bucket_weights = { USD: 0.5, EUR: 0.5 };
    const gen = createRowGenerator(schema, { seed: 11 });
    for (let i = 0; i < 5_000; i++) {
      expect(gen.generate("GIRR").bucket).not.toBe("GBP");
    }
  });

  it("missing bucket_weights → uniform behaviour (regression guard for existing fixtures)", () => {
    // Use base fixture as-is (no bucket_weights). For GIRR with 3 buckets,
    // uniform expectation = 1/3 per bucket; ±5% tolerance comfortably covers
    // sampling noise at N=10k without making the assertion vacuous.
    const gen = createRowGenerator(baseSchema, { seed: 99 });
    const N = 10_000;
    const rows: { bucket: string }[] = new Array(N);
    for (let i = 0; i < N; i++) rows[i] = gen.generate("GIRR");
    const hist = histogram(rows);
    const buckets = baseSchema.risk_classes.GIRR!.buckets.values;
    expect(Object.keys(hist).sort()).toEqual([...buckets].sort());
    const expected = 1 / buckets.length;
    for (const b of buckets) {
      const observed = (hist[b] ?? 0) / N;
      expect(Math.abs(observed - expected)).toBeLessThan(0.02);
    }
  });

  it("weights need not sum to 1 — generator normalises (×10 produces same distribution)", () => {
    const schema = cloneSchema(baseSchema);
    schema.risk_classes.GIRR!.bucket_weights = { USD: 6, EUR: 3, GBP: 1 };
    const gen = createRowGenerator(schema, { seed: 42 });
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

  it("with weights, the bucket pick still consumes exactly one rng() tick — risk_value sequence is identical across weight configurations sharing the same chosen bucket index", () => {
    // Same seed, two weighting configurations that put 100% on USD. Bucket is
    // always USD in both; therefore the post-pick rng() draws (risk_value,
    // tenor, tag, numeric) must be bit-identical because the bucket pick
    // consumes one rng() tick in either branch.
    const schemaA = cloneSchema(baseSchema);
    schemaA.risk_classes.GIRR!.bucket_weights = { USD: 1, EUR: 0, GBP: 0 };
    const schemaB = cloneSchema(baseSchema);
    schemaB.risk_classes.GIRR!.bucket_weights = { USD: 100, EUR: 0, GBP: 0 };
    const a = createRowGenerator(schemaA, { seed: 0 });
    const b = createRowGenerator(schemaB, { seed: 0 });
    for (let i = 0; i < 50; i++) {
      const ra = a.generate("GIRR");
      const rb = b.generate("GIRR");
      expect(rb.bucket).toBe(ra.bucket);
      expect(rb.risk_value).toEqual(ra.risk_value);
      expect(rb.weight).toEqual(ra.weight);
    }
  });
});

describe("createRowGenerator — frtb-default.yaml ships bucket_weights for every class (Wave 5.47a)", () => {
  it("each FRTB risk class declares a non-empty bucket_weights map in the default schema", () => {
    const defaultSchema = loadSchema(
      resolve(here, "../../../config/schema/frtb-default.yaml"),
    );
    for (const cls of Object.keys(defaultSchema.risk_classes)) {
      const cfg = defaultSchema.risk_classes[cls]!;
      expect(cfg.bucket_weights, `${cls} bucket_weights`).toBeTruthy();
      const total = Object.values(cfg.bucket_weights!).reduce(
        (a, b) => a + (b as number),
        0,
      );
      expect(total, `${cls} bucket_weights total`).toBeGreaterThan(0);
    }
  });
});
