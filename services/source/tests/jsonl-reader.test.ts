// Failing tests for the streaming JSONL sample reader.

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleJsonl } from "../src/readers/jsonl.ts";

const FIXTURES = resolve(fileURLToPath(import.meta.url), "..", "fixtures");

describe("sampleJsonl", () => {
  it("reads a JSON object per line and surfaces the union of keys as columns", async () => {
    const out = await sampleJsonl(resolve(FIXTURES, "girr-small.jsonl"), { limit: 100 });
    expect(out.columns.sort()).toEqual(
      ["bucket", "risk_class", "risk_value", "sensitivity_type", "tenor", "trade_id"],
    );
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toMatchObject({ risk_class: "GIRR", bucket: "USD-IRS" });
  });

  it("respects the sample limit", async () => {
    const out = await sampleJsonl(resolve(FIXTURES, "girr-small.jsonl"), { limit: 2 });
    expect(out.rows).toHaveLength(2);
  });

  it("coerces values to strings on the row map (downstream type inference owns coercion)", async () => {
    const out = await sampleJsonl(resolve(FIXTURES, "girr-small.jsonl"), { limit: 1 });
    // numeric tenor in JSONL — exposed as a string on the row, like the CSV reader.
    expect(typeof out.rows[0]!.tenor).toBe("string");
    expect(out.rows[0]!.tenor).toBe("0.25");
  });
});
