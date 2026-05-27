import { describe, it, expect } from "vitest";
import { computeKbEquityDelta } from "../src/equityDeltaReference.ts";

// Pure-TS oracle for Equity Delta K_b — MAR21 §21.78–§21.83.
// Each row within a bucket represents a distinct equity issuer k:
//   WS_k = w_bucket · s_k                 (per-row weighted sensitivity)
//   S_b  = Σ_k WS_k
//   K_b² = Σ_k WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²)
//   K_b  = √max(0, K_b²)
// Only rows whose sensitivity_type === "Delta" contribute.

const W_B1 = 0.55;   // Equity bucket 1 weight (from frtb-default.yaml.equity_weights.by_bucket)
const RHO_EQ = 0.50; // equity_rho.value

describe("computeKbEquityDelta (TS reference oracle)", () => {
  it("computes WS per row and K_b for a hand-computed 3-row fixture (ρ=0.5)", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: 1.0 },
      { sensitivity_type: "Delta", risk_value: 2.0 },
      { sensitivity_type: "Delta", risk_value: -0.5 },
    ];
    const out = computeKbEquityDelta(rows, W_B1, RHO_EQ);

    const ws = [W_B1 * 1.0, W_B1 * 2.0, W_B1 * -0.5];
    for (let k = 0; k < ws.length; k++) expect(out.WS[k]).toBeCloseTo(ws[k]!, 12);

    const sumWs = ws.reduce((a, b) => a + b, 0);
    const sumWsSq = ws.reduce((a, b) => a + b * b, 0);
    const expectedK = Math.sqrt(sumWsSq + RHO_EQ * (sumWs * sumWs - sumWsSq));
    expect(out.K_b).toBeCloseTo(expectedK, 12);
    expect(out.S_b).toBeCloseTo(sumWs, 12);
    expect(out.count).toBe(3);
  });

  it("ignores non-Delta sensitivity rows (Vega / Curvature filtered)", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: 1.0 },
      { sensitivity_type: "Vega", risk_value: 9.0 },
      { sensitivity_type: "Curvature", risk_value: 9.0 },
    ];
    const out = computeKbEquityDelta(rows, W_B1, RHO_EQ);
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(W_B1, 12);
    expect(out.S_b).toBeCloseTo(W_B1, 12);
  });

  it("collapses to √ΣWS² when ρ=0", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: 3.0 },
      { sensitivity_type: "Delta", risk_value: 4.0 },
    ];
    const out = computeKbEquityDelta(rows, 1.0, 0);
    expect(out.K_b).toBeCloseTo(5, 12); // √(3² + 4²)
  });

  it("equals |ΣWS| when ρ=1 (perfect correlation)", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: 3.0 },
      { sensitivity_type: "Delta", risk_value: 4.0 },
    ];
    const out = computeKbEquityDelta(rows, 1.0, 1);
    expect(out.K_b).toBeCloseTo(7, 12);
  });

  it("returns zeros for an empty bucket", () => {
    const out = computeKbEquityDelta([], W_B1, RHO_EQ);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
    expect(out.count).toBe(0);
  });

  it("skips non-finite risk_value rows", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: 1.0 },
      { sensitivity_type: "Delta", risk_value: NaN },
      { sensitivity_type: "Delta", risk_value: 2.0 },
    ];
    const out = computeKbEquityDelta(rows, 1.0, 0);
    // Valid WS = [1, 2]; K_b = √(1+4) = √5
    expect(out.K_b).toBeCloseTo(Math.sqrt(5), 12);
    expect(out.count).toBe(2);
  });
});
