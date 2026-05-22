// Failing tests for the streaming CSV sample reader.
//
// The reader must:
//   - parse the header row
//   - parse N rows from the body (configurable sample size)
//   - handle double-quoted fields with embedded commas + escaped quotes
//   - stop reading after the sample limit (don't load the whole file)

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleCsv } from "../src/readers/csv.ts";

const FIXTURES = resolve(fileURLToPath(import.meta.url), "..", "fixtures");

describe("sampleCsv", () => {
  it("returns header columns and rows from a small file", async () => {
    const out = await sampleCsv(resolve(FIXTURES, "girr-small.csv"), { limit: 100 });
    expect(out.columns).toEqual([
      "risk_class", "bucket", "sensitivity_type", "tenor", "risk_value",
      "weight", "trade_id", "book", "currency",
    ]);
    expect(out.rows).toHaveLength(6);
    expect(out.rows[0]).toMatchObject({ risk_class: "GIRR", bucket: "USD-IRS", tenor: "0.25" });
  });

  it("respects the sample limit", async () => {
    const out = await sampleCsv(resolve(FIXTURES, "girr-small.csv"), { limit: 2 });
    expect(out.rows).toHaveLength(2);
  });

  it("parses quoted fields with embedded commas and escaped quotes", async () => {
    const out = await sampleCsv(resolve(FIXTURES, "quoted.csv"), { limit: 100 });
    expect(out.columns).toEqual(["name", "description", "value"]);
    expect(out.rows[0]).toEqual({ name: "Alpha", description: "first, comma inside", value: "1.5" });
    expect(out.rows[1]).toEqual({ name: "Beta", description: 'quoted "inner" word', value: "2.5" });
    expect(out.rows[2]).toEqual({ name: "Gamma", description: "plain", value: "3.5" });
  });

  it("returns row_count_seen alongside the sample", async () => {
    const out = await sampleCsv(resolve(FIXTURES, "girr-small.csv"), { limit: 100 });
    expect(out.row_count_seen).toBe(6);
  });
});
