import { describe, it, expect } from "vitest";
import { computeFxCurvatureCharge } from "../src/fxCurvatureReference.ts";

// Pure-TS oracle for FX Curvature — MAR21 §21.5(2)–(3), §21.5(5), §21.5(5)(b).
// Shape A: each row carries scalar pre-computed CVR^+ / CVR^- (one FX factor k).
//   K_b^{+|-}² = Σ_k CVR_k² + Σ_{k≠l} ρ² · CVR_k · CVR_l · ψ(.)        §21.5(3)
//   K_b = max(K_b^+, K_b^-) ; S_b = Σ_k CVR_k of the winning direction §21.5(3)(5)
//   charge = √max(0, Σ_b K_b² + Σ_{b≠c} γ² · S_b · S_c · ψ(S_b, S_c))   §21.5(5)

describe("computeFxCurvatureCharge (TS reference oracle)", () => {
  it("single bucket, two FX factors, positive interior (ρ_delta=0.5, ρ²=0.25)", () => {
    const rows = [
      { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 1, cvr_down: -0.5 } },
      { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 2, cvr_down: -1 } },
    ];
    const out = computeFxCurvatureCharge(rows, {
      intraBucketRhoDelta: 0.5,
      crossBucketGammaDelta: { kind: "constant", value: 0 },
    });
    const b = out.perBucket[0]!;
    expect(b.bucket).toBe("EURUSD");
    expect(b.count).toBe(2);
    // CVR_up=[1,2] ⇒ K_b_up² = 5 + 0.25·(1·2+2·1) = 6.
    expect(b.K_b_up).toBeCloseTo(Math.sqrt(6), 12);
    // CVR_down=[-0.5,-1] both negative ⇒ ψ=0 ⇒ K_b_down² = 1.25.
    expect(b.K_b_down).toBeCloseTo(Math.sqrt(1.25), 12);
    expect(b.K_b).toBeCloseTo(Math.sqrt(6), 12);
    expect(b.S_b).toBeCloseTo(3, 12);
    expect(b.direction).toBe("up");
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(6), 12);
    expect(out.usedFallback).toBe(false);
  });

  it("triggers §21.5(5)(b) fallback when sum_K2 + cross < 0 (ρ_delta=γ_delta=1)", () => {
    const rows = [
      { sensitivity_type: "Curvature", bucket: "GBPUSD", risk_value: { cvr_up: -3, cvr_down: 0 } },
      { sensitivity_type: "Curvature", bucket: "GBPUSD", risk_value: { cvr_up: -3, cvr_down: 0 } },
      { sensitivity_type: "Curvature", bucket: "JPYUSD", risk_value: { cvr_up: 3, cvr_down: 0 } },
      { sensitivity_type: "Curvature", bucket: "JPYUSD", risk_value: { cvr_up: 3, cvr_down: 0 } },
    ];
    const out = computeFxCurvatureCharge(rows, {
      intraBucketRhoDelta: 1,
      crossBucketGammaDelta: { kind: "constant", value: 1 },
    });
    const A = out.perBucket.find((p) => p.bucket === "GBPUSD")!;
    const B = out.perBucket.find((p) => p.bucket === "JPYUSD")!;
    expect(A.K_b).toBeCloseTo(Math.sqrt(18), 12);
    expect(A.S_b).toBeCloseTo(-6, 12);
    expect(B.K_b).toBeCloseTo(6, 12);
    expect(B.S_b).toBeCloseTo(6, 12);
    // sumK2=54; cross=2·(-6)·6=-72 ⇒ -18 ⇒ §21.5(5)(b) clip and recompute.
    expect(out.usedFallback).toBe(true);
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(54 - 12 * Math.sqrt(18)), 12);
  });

  it("multi-bucket γ² cross aggregation with mixed up/down winners per bucket", () => {
    const rows = [
      { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 2, cvr_down: -1 } },
      { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 1, cvr_down: -1 } },
      { sensitivity_type: "Curvature", bucket: "GBPUSD", risk_value: { cvr_up: -2, cvr_down: 3 } },
      { sensitivity_type: "Curvature", bucket: "GBPUSD", risk_value: { cvr_up: -1, cvr_down: 2 } },
    ];
    const out = computeFxCurvatureCharge(rows, {
      intraBucketRhoDelta: 0.5,
      crossBucketGammaDelta: { kind: "constant", value: 0.5 },
    });
    const b1 = out.perBucket.find((p) => p.bucket === "EURUSD")!;
    const b2 = out.perBucket.find((p) => p.bucket === "GBPUSD")!;
    expect(b1.K_b).toBeCloseTo(Math.sqrt(6), 12);
    expect(b1.direction).toBe("up");
    expect(b1.S_b).toBeCloseTo(3, 12);
    expect(b2.K_b).toBeCloseTo(4, 12);
    expect(b2.direction).toBe("down");
    expect(b2.S_b).toBeCloseTo(5, 12);
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(29.5), 12);
    expect(out.direction).toBe("mixed");
  });

  it("defaults schema fields to zero (matches fxDeltaReference convention)", () => {
    const rows = [
      { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 3, cvr_down: -4 } },
    ];
    const out = computeFxCurvatureCharge(rows);
    // Single factor ⇒ no cross term; K_b_up=3, K_b_down=4, K_b=4, S_b=-4.
    const b = out.perBucket[0]!;
    expect(b.K_b_up).toBeCloseTo(3, 12);
    expect(b.K_b_down).toBeCloseTo(4, 12);
    expect(b.K_b).toBeCloseTo(4, 12);
    expect(b.direction).toBe("down");
    expect(b.S_b).toBeCloseTo(-4, 12);
    expect(out.riskClassCharge).toBeCloseTo(4, 12);
    expect(out.direction).toBe("down");
  });

  it("same-direction mixed-sign CVR pair exercises the ψ=1 branch with negatives present (verifier gap fix)", () => {
    // Single bucket, two FX factors. Factor 1: cvr_up=+2, cvr_down=-0.5.
    // Factor 2: cvr_up=-1, cvr_down=+1.5. ρ_delta=0.5 ⇒ ρ²=0.25.
    // Every (k,l) pair has at least one non-negative ⇒ ψ=1 throughout (the gap
    // the verifier flagged — ψ=0 branch tested but ψ=1-with-negatives was not).
    // Hand-computed expected values:
    //   K_b_up²   = 2² + (-1)² + 0.25·(2·(-1) + (-1)·2)         = 5 + 0.25·(-4) = 4
    //   K_b_up    = 2
    //   K_b_down² = (-0.5)² + 1.5² + 0.25·((-0.5)·1.5 + 1.5·(-0.5)) = 2.5 + 0.25·(-1.5) = 2.125
    //   K_b_down  = √2.125
    //   K_b       = max(2, √2.125) = 2, direction = "up"
    //   S_b       = 2 + (-1) = 1
    const rows = [
      { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 2.0, cvr_down: -0.5 } },
      { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: -1.0, cvr_down: 1.5 } },
    ];
    const out = computeFxCurvatureCharge(rows, {
      intraBucketRhoDelta: 0.5,
      crossBucketGammaDelta: { kind: "constant", value: 0 },
    });
    const b = out.perBucket[0]!;
    expect(b.K_b_up).toBeCloseTo(2, 12);
    expect(b.K_b_down).toBeCloseTo(Math.sqrt(2.125), 12);
    expect(b.K_b).toBeCloseTo(2, 12);
    expect(b.direction).toBe("up");
    expect(b.S_b).toBeCloseTo(1, 12);
    expect(out.riskClassCharge).toBeCloseTo(2, 12);
    expect(out.usedFallback).toBe(false);
  });

  it("ignores non-Curvature rows and returns zeros for an empty input", () => {
    const out = computeFxCurvatureCharge([
      { sensitivity_type: "Vega", bucket: "EURUSD", risk_value: { cvr_up: 9, cvr_down: -9 } },
    ]);
    expect(out.perBucket).toHaveLength(0);
    expect(out.riskClassCharge).toBe(0);
  });
});
