import { describe, it, expect } from "vitest";
import { computeKbVega } from "../src/girrVegaReference.ts";

// Pure-TS reference (oracle) for the Vega K_b math per CRE22.62.
// Used by integration tests and downstream cross-check tooling.
describe("computeKbVega (TS reference oracle)", () => {
  it("equals √(ΣWS² + ρ·((ΣWS)² − ΣWS²)) for constant w & ρ", () => {
    const rows = [[0.5, 1.0], [1.0, 0.5]];
    const out = computeKbVega(rows, 1.0, 0.5);
    expect(out.K_b).toBeCloseTo(Math.sqrt(5.75), 12);
    expect(out.S_b).toBeCloseTo(3.0, 12);
    expect(out.count).toBe(2);
  });

  it("collapses to √ΣWS² when ρ=0", () => {
    const out = computeKbVega([[0.3, 0.4]], 1.0, 0.0);
    expect(out.K_b).toBeCloseTo(0.5, 12);
  });

  it("scales linearly with weight", () => {
    const a = computeKbVega([[1, 2, 3]], 1.0, 0.2);
    const b = computeKbVega([[1, 2, 3]], 2.0, 0.2);
    expect(b.K_b).toBeCloseTo(2 * a.K_b, 12);
    expect(b.S_b).toBeCloseTo(2 * a.S_b, 12);
  });

  it("returns zeros for an empty bucket", () => {
    const out = computeKbVega([], 0.18, 0.4);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
    expect(out.count).toBe(0);
  });

  // Wave 5.52 — sparse per-tenor object inputs from the variable-length
  // generator. Missing keys must be skipped (not coerced to 0) so the kernel
  // and reference oracle agree on the resulting K_b.
  describe("Wave 5.52: sparse per-tenor object", () => {
    const GIRR_TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"];
    const W = 1.0;
    const RHO = 0.4;

    it("K_b matches the hand-computed value for a sparse {3M, 10Y} row", () => {
      const sparse = { "3M": 0.5, "10Y": 1.5 };
      const out = computeKbVega(
        [{ sensitivity_type: "Vega", risk_value: sparse }],
        W,
        RHO,
        GIRR_TENORS,
      );
      const ws1 = W * 0.5;
      const ws2 = W * 1.5;
      const sumWs = ws1 + ws2;
      const sumWsSq = ws1 * ws1 + ws2 * ws2;
      const expectedKb = Math.sqrt(sumWsSq + RHO * (sumWs * sumWs - sumWsSq));
      expect(out.K_b).toBeCloseTo(expectedKb, 12);
      expect(out.S_b).toBeCloseTo(sumWs, 12);
      expect(out.count).toBe(1);
    });

    it("missing tenor keys do not contribute to WS sum", () => {
      const dense = { "3M": 1, "6M": 1, "1Y": 1, "2Y": 1, "3Y": 1, "5Y": 1, "10Y": 1, "15Y": 1, "20Y": 1, "30Y": 1 };
      const sparse = { "3M": 1, "30Y": 1 };
      const denseOut = computeKbVega(
        [{ sensitivity_type: "Vega", risk_value: dense }],
        W,
        RHO,
        GIRR_TENORS,
      );
      const sparseOut = computeKbVega(
        [{ sensitivity_type: "Vega", risk_value: sparse }],
        W,
        RHO,
        GIRR_TENORS,
      );
      expect(denseOut.S_b).toBeCloseTo(10, 12);
      expect(sparseOut.S_b).toBeCloseTo(2, 12);
    });
  });
});
