import { describe, it, expect } from "vitest";
import { computeKbFxVega } from "../src/fxVegaReference.ts";

// Pure-TS oracle for FX Vega K_b — MAR21 §21.92.
// Same single-factor-per-pair specialisation as FX Delta, filtered to Vega rows.

const W_FX_VEGA = 1.0; // Representative vega weight (same pattern as GIRR vega)

describe("computeKbFxVega (TS reference oracle)", () => {
  it("returns |w · Σs| over Vega rows only", () => {
    const rows = [
      { sensitivity_type: "Vega", risk_value: 0.4 },
      { sensitivity_type: "Vega", risk_value: 0.6 },
      { sensitivity_type: "Delta", risk_value: 99 }, // filtered out
    ];
    const out = computeKbFxVega(rows, W_FX_VEGA);
    expect(out.S_b).toBeCloseTo(1.0, 12);
    expect(out.K_b).toBeCloseTo(1.0, 12);
    expect(out.count).toBe(2);
  });

  it("scales linearly with weight", () => {
    const rows = [{ sensitivity_type: "Vega", risk_value: 2.0 }];
    const a = computeKbFxVega(rows, 1.0);
    const b = computeKbFxVega(rows, 2.0);
    expect(b.K_b).toBeCloseTo(2 * a.K_b, 12);
    expect(b.S_b).toBeCloseTo(2 * a.S_b, 12);
  });

  it("returns zeros for an empty bucket", () => {
    const out = computeKbFxVega([], W_FX_VEGA);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
    expect(out.count).toBe(0);
  });
});
