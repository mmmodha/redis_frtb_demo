import { describe, it, expect } from "vitest";
import { computeKbFxDelta } from "../src/fxDeltaReference.ts";

// Pure-TS oracle for FX Delta K_b — MAR21 §21.88–§21.91 with the
// constant-ρ specialisation (matches the Python oracle's scalar_constant
// kernel). K_b² = Σ WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²); with the default
// ρ=0 used by these reference assertions the kernel reduces to
// K_b = sqrt(Σ WS_k²) (and to |WS| for a single-row bucket).
// Only rows with sensitivity_type === "Delta" contribute.

const W_FX = 0.075;  // fx_weights.constant from frtb-default.yaml

describe("computeKbFxDelta (TS reference oracle)", () => {
  it("returns sqrt(Σ WS²) for a multi-row bucket with ρ=0", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: 1.0 },
      { sensitivity_type: "Delta", risk_value: 2.5 },
      { sensitivity_type: "Delta", risk_value: -0.5 },
    ];
    const out = computeKbFxDelta(rows, W_FX);
    const expectedSumWs = W_FX * (1.0 + 2.5 - 0.5);
    const expectedKb = W_FX * Math.sqrt(1.0 * 1.0 + 2.5 * 2.5 + 0.5 * 0.5);
    expect(out.K_b).toBeCloseTo(expectedKb, 12);
    expect(out.S_b).toBeCloseTo(expectedSumWs, 12);
    expect(out.count).toBe(3);
  });

  it("ignores non-Delta sensitivity rows", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: 1.0 },
      { sensitivity_type: "Vega", risk_value: 9.0 },
      { sensitivity_type: "Curvature", risk_value: 9.0 },
    ];
    const out = computeKbFxDelta(rows, 1.0);
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(1.0, 12);
    expect(out.S_b).toBeCloseTo(1.0, 12);
  });

  it("returns |w · s| for a single-row bucket", () => {
    const rows = [{ sensitivity_type: "Delta", risk_value: -3.0 }];
    const out = computeKbFxDelta(rows, 0.075);
    expect(out.K_b).toBeCloseTo(0.225, 12);
    expect(out.S_b).toBeCloseTo(-0.225, 12);
  });

  it("returns zeros for an empty bucket", () => {
    const out = computeKbFxDelta([], W_FX);
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
    const out = computeKbFxDelta(rows, 1.0);
    expect(out.S_b).toBeCloseTo(3.0, 12);
    // ρ=0 default → K_b = sqrt(1² + 2²) = sqrt(5).
    expect(out.K_b).toBeCloseTo(Math.sqrt(5), 12);
    expect(out.count).toBe(2);
  });
});
