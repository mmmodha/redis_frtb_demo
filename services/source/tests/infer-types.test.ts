// Failing tests for column type inference.
//
// Rules:
//   - all values parse as numbers (incl. ints + floats, allows ".") → NUMERIC
//   - all values are short strings (≤32 chars) with cardinality ≤ 50% of samples → TAG
//   - high cardinality / long strings → TEXT
//   - empty samples → defaults to TEXT
//   - boolean-looking values (true/false/0/1) → keep simple: NUMERIC if 0/1, TAG if true/false

import { describe, it, expect } from "vitest";
import { inferColumnType, inferAllColumns } from "../src/infer/types.ts";

describe("inferColumnType", () => {
  it("classifies all-numeric samples as NUMERIC", () => {
    expect(inferColumnType(["1", "2.5", "-3.14", "0"])).toBe("NUMERIC");
  });

  it("treats blanks as missing and ignores them when classifying", () => {
    expect(inferColumnType(["1", "", "2", "  "])).toBe("NUMERIC");
  });

  it("classifies low-cardinality short strings as TAG", () => {
    expect(inferColumnType(["GIRR", "EQUITY", "FX", "GIRR", "FX", "GIRR"])).toBe("TAG");
  });

  it("classifies very high-cardinality short strings as TEXT", () => {
    const samples = Array.from({ length: 50 }, (_, i) => `t-${i}`);
    expect(inferColumnType(samples)).toBe("TEXT");
  });

  it("classifies long strings as TEXT", () => {
    expect(inferColumnType([
      "this is a long description that definitely exceeds the tag length budget".repeat(2),
      "another long description that exceeds the tag length budget".repeat(2),
    ])).toBe("TEXT");
  });

  it("defaults to TEXT when all samples are empty", () => {
    expect(inferColumnType(["", "", "  "])).toBe("TEXT");
  });
});

describe("inferAllColumns", () => {
  it("returns a per-column type map plus sample values", () => {
    const rows = [
      { risk_class: "GIRR", bucket: "USD-IRS", weight: "0.017", trade_id: "T-001" },
      { risk_class: "GIRR", bucket: "EUR-IRS", weight: "0.013", trade_id: "T-002" },
      { risk_class: "EQUITY", bucket: "B1", weight: "0.55", trade_id: "T-003" },
    ];
    const cols = inferAllColumns(rows, ["risk_class", "bucket", "weight", "trade_id"]);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.risk_class!.detected_type).toBe("TAG");
    expect(byName.bucket!.detected_type).toBe("TAG");
    expect(byName.weight!.detected_type).toBe("NUMERIC");
    // trade_id has 3 unique values across 3 rows → 100% cardinality → TEXT (id-ish)
    expect(byName.trade_id!.detected_type).toBe("TEXT");
    expect(byName.risk_class!.sample_values.length).toBeGreaterThan(0);
  });
});
