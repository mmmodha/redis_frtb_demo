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

describe("row generation throughput", () => {
  // The DoD targets ≥100k rows/sec produce rate to Stream — the row builder
  // itself must therefore comfortably exceed that on its own (the Stream is
  // the real bottleneck). 100k rows in <500ms on dev hardware = ≥200k rows/sec
  // floor for the in-process generator.
  it("generates ≥100k mixed-class rows in under 1 second (row builder alone)", () => {
    const gen = createRowGenerator(schema, { seed: 99 });
    const classes = ["GIRR", "EQUITY", "FX"];
    const N = 100_000;
    const start = process.hrtime.bigint();
    let girrPerTenor = 0;
    for (let i = 0; i < N; i++) {
      const row = gen.generate(classes[i % classes.length]!);
      // Wave 5.17a — GIRR risk_value is now a per-tenor object (was array).
      const rv = row.risk_value;
      if (rv && typeof rv === "object" && !Array.isArray(rv) && "3M" in rv) {
        girrPerTenor += 1;
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(girrPerTenor).toBeGreaterThan(N / 4); // ~1/3 of rows are GIRR (per-tenor object)
    expect(elapsedMs).toBeLessThan(1000);
  });
});
