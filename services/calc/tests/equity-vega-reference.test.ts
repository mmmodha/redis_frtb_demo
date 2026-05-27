import { describe, it, expect } from "vitest";
import { computeKbEquityVega } from "../src/equityVegaReference.ts";

// Pure-TS oracle for Equity Vega K_b — MAR21 §21.92.
// Same constant-ρ specialisation as Equity Delta:
//   WS_k = w · s_k                       (per-row weighted vega sensi)
//   K_b² = ΣWS_k² + ρ · ((ΣWS_k)² − ΣWS_k²)
// Only rows with sensitivity_type === "Vega" contribute.

const W_VEGA = 1.0;   // PoV uses a representative constant (matches girr_vega_weights pattern)
const RHO_EQ = 0.50;  // equity_rho.value (re-used for vega in PoV)

describe("computeKbEquityVega (TS reference oracle)", () => {
  it("computes K_b for a hand-computed 2-row vega fixture (ρ=0.5)", () => {
    const rows = [
      { sensitivity_type: "Vega", risk_value: 0.5 },
      { sensitivity_type: "Vega", risk_value: 1.0 },
    ];
    const out = computeKbEquityVega(rows, W_VEGA, RHO_EQ);
    // WS = [0.5, 1.0]; ΣWS²=1.25; (ΣWS)²=2.25; K_b² = 1.25 + 0.5·(2.25-1.25) = 1.75
    expect(out.K_b).toBeCloseTo(Math.sqrt(1.75), 12);
    expect(out.S_b).toBeCloseTo(1.5, 12);
    expect(out.count).toBe(2);
  });

  it("filters out non-Vega sensitivity rows", () => {
    const rows = [
      { sensitivity_type: "Vega", risk_value: 1.0 },
      { sensitivity_type: "Delta", risk_value: 9.0 },
      { sensitivity_type: "Curvature", risk_value: 9.0 },
    ];
    const out = computeKbEquityVega(rows, W_VEGA, 0);
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(W_VEGA, 12);
  });

  it("scales linearly with weight", () => {
    const rows = [{ sensitivity_type: "Vega", risk_value: 2.0 }];
    const a = computeKbEquityVega(rows, 1.0, 0.4);
    const b = computeKbEquityVega(rows, 2.0, 0.4);
    expect(b.K_b).toBeCloseTo(2 * a.K_b, 12);
    expect(b.S_b).toBeCloseTo(2 * a.S_b, 12);
  });

  it("returns zeros for an empty bucket", () => {
    const out = computeKbEquityVega([], W_VEGA, RHO_EQ);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
    expect(out.count).toBe(0);
  });
});
