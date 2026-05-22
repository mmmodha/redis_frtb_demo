import { describe, it, expect } from "vitest";
import { reduceRiskClassCharge } from "../src/sbm/reduce.ts";

// Basel SBM risk-class charge:
//   charge = sqrt( sum K_b^2  +  sum_{b!=c} gamma_bc * S_b * S_c )
// When the value inside the sqrt is negative, MAR21.4(7) alternative formula
// applies. For the demo with positive synthetic data we exercise the primary
// formula; the alt-formula branch is also covered as a guardrail.

describe("reduceRiskClassCharge — constant γ_bc", () => {
  it("returns √(ΣK² + ΣΣγ·S·S) for a single bucket (γ irrelevant)", () => {
    const out = reduceRiskClassCharge(
      [{ bucket: "USD-IRS", K_b: 1, S_b: 1, count: 1, ms: 1 }],
      { kind: "constant", value: 0.5 }
    );
    expect(out).toBeCloseTo(1, 10); // sqrt(1) = 1
  });

  it("two buckets with γ=0 → charge = sqrt(K1² + K2²)", () => {
    const out = reduceRiskClassCharge(
      [
        { bucket: "USD-IRS", K_b: 3, S_b: 3, count: 1, ms: 1 },
        { bucket: "EUR-IRS", K_b: 4, S_b: 4, count: 1, ms: 1 },
      ],
      { kind: "constant", value: 0 }
    );
    expect(out).toBeCloseTo(Math.sqrt(9 + 16), 10); // 5
  });

  it("two buckets with γ=0.5, S1=S2=K1=K2=2 → charge = √(4+4 + 2·0.5·2·2) = √12", () => {
    const out = reduceRiskClassCharge(
      [
        { bucket: "USD-IRS", K_b: 2, S_b: 2, count: 1, ms: 1 },
        { bucket: "EUR-IRS", K_b: 2, S_b: 2, count: 1, ms: 1 },
      ],
      { kind: "constant", value: 0.5 }
    );
    // ΣK² = 8; cross = 2 * (0.5 * 2 * 2) = 4 (both off-diagonal pairs (1,2) and (2,1))
    expect(out).toBeCloseTo(Math.sqrt(12), 10);
  });

  it("returns 0 for empty bucket list", () => {
    expect(reduceRiskClassCharge([], { kind: "constant", value: 0.5 })).toBe(0);
  });

  it("alt-formula branch: when ΣK² + cross < 0 uses MAR21.4(7) fallback", () => {
    // Pick K_b small, S_b large negative + positive so γ·S·S dominates negative
    const out = reduceRiskClassCharge(
      [
        { bucket: "A", K_b: 1, S_b: -10, count: 1, ms: 1 },
        { bucket: "B", K_b: 1, S_b: 10, count: 1, ms: 1 },
      ],
      { kind: "constant", value: 0.99 }
    );
    // ΣK² = 2; cross = 2 * (0.99 * -10 * 10) = -198. Sum negative → alt formula.
    // Alt: sqrt( ΣK_b² + ΣΣ γ_bc · S_b^+ · S_c^+ ) where S_b^+ = max(min(S_b, K_b), -K_b)
    // S_A^+ = max(min(-10,1),-1) = -1; S_B^+ = 1.
    // Cross+ = 2*(0.99 * -1 * 1) = -1.98. Σ = 2 - 1.98 = 0.02. sqrt ≈ 0.1414
    expect(out).toBeCloseTo(Math.sqrt(0.02), 6);
  });
});

describe("reduceRiskClassCharge — matrix γ_bc", () => {
  it("uses matrix correlation indexed by bucket label", () => {
    const out = reduceRiskClassCharge(
      [
        { bucket: "1", K_b: 2, S_b: 2, count: 1, ms: 1 },
        { bucket: "2", K_b: 2, S_b: 2, count: 1, ms: 1 },
      ],
      {
        kind: "matrix",
        labels: ["1", "2"],
        matrix: [
          [1, 0.25],
          [0.25, 1],
        ],
      }
    );
    // ΣK² = 8; cross = 2 * (0.25 * 2 * 2) = 2 → sqrt(10)
    expect(out).toBeCloseTo(Math.sqrt(10), 10);
  });
});
