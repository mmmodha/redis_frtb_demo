import { describe, it, expect } from "vitest";
import { computeEquityCurvatureCharge } from "../src/equityCurvatureReference.ts";

// Pure-TS oracle for Equity Curvature — MAR21 §21.5(2)–(3), §21.5(5), §21.5(5)(b).
// Shape A: each row carries scalar pre-computed CVR^+ / CVR^- (one issuer factor k).
//   K_b^{+|-}² = Σ_k CVR_k² + Σ_{k≠l} ρ² · CVR_k · CVR_l · ψ(.)        §21.5(3)
//   K_b = max(K_b^+, K_b^-) ; S_b = Σ_k CVR_k of the winning direction §21.5(3)(5)
//   charge = √max(0, Σ_b K_b² + Σ_{b≠c} γ² · S_b · S_c · ψ(S_b, S_c))   §21.5(5)
//   §21.5(5)(b) fallback: when interior < 0, clip S_b ∈ [-K_b, K_b].

describe("computeEquityCurvatureCharge (TS reference oracle)", () => {
  it("single bucket, two issuer factors, positive interior (ρ_delta=0.5, ρ²=0.25)", () => {
    const rows = [
      { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: 1, cvr_down: -0.5 } },
      { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: 2, cvr_down: -1 } },
    ];
    const out = computeEquityCurvatureCharge(rows, {
      intraBucketRhoDelta: 0.5,
      crossBucketGammaDelta: { kind: "constant", value: 0 },
    });
    const b = out.perBucket[0]!;
    expect(b.bucket).toBe("1");
    expect(b.count).toBe(2);
    // CVR_up=[1,2] ⇒ K_b_up² = 5 + 0.25·(1·2+2·1) = 6.
    expect(b.K_b_up).toBeCloseTo(Math.sqrt(6), 12);
    // CVR_down=[-0.5,-1] both negative ⇒ ψ=0 ⇒ K_b_down² = 1.25.
    expect(b.K_b_down).toBeCloseTo(Math.sqrt(1.25), 12);
    expect(b.K_b).toBeCloseTo(Math.sqrt(6), 12);
    expect(b.S_b).toBeCloseTo(3, 12);
    expect(b.direction).toBe("up");
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(6), 12);
    expect(out.direction).toBe("up");
    expect(out.usedFallback).toBe(false);
  });

  it("triggers §21.5(5)(b) fallback when sum_K2 + cross < 0 (ρ_delta=γ_delta=1)", () => {
    const rows = [
      // Bucket "A": two issuer factors with CVR_up=-3 each ⇒ ψ=0 ⇒ K_b²=18.
      { sensitivity_type: "Curvature", bucket: "A", risk_value: { cvr_up: -3, cvr_down: 0 } },
      { sensitivity_type: "Curvature", bucket: "A", risk_value: { cvr_up: -3, cvr_down: 0 } },
      // Bucket "B": two issuer factors with CVR_up=3 each ⇒ ψ=1 ⇒ K_b²=18+18=36 ⇒ K_b=6.
      { sensitivity_type: "Curvature", bucket: "B", risk_value: { cvr_up: 3, cvr_down: 0 } },
      { sensitivity_type: "Curvature", bucket: "B", risk_value: { cvr_up: 3, cvr_down: 0 } },
    ];
    const out = computeEquityCurvatureCharge(rows, {
      intraBucketRhoDelta: 1,
      crossBucketGammaDelta: { kind: "constant", value: 1 },
    });
    const A = out.perBucket.find((p) => p.bucket === "A")!;
    const B = out.perBucket.find((p) => p.bucket === "B")!;
    expect(A.K_b).toBeCloseTo(Math.sqrt(18), 12);
    expect(A.S_b).toBeCloseTo(-6, 12);
    expect(B.K_b).toBeCloseTo(6, 12);
    expect(B.S_b).toBeCloseTo(6, 12);
    // sumK2=54; cross=2·(-6)·6=-72; sum=-18 ⇒ §21.5(5)(b) clip S_A=-√18, S_B=6.
    expect(out.usedFallback).toBe(true);
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(54 - 12 * Math.sqrt(18)), 12);
  });

  it("multi-bucket γ² cross aggregation with mixed up/down winners per bucket", () => {
    const rows = [
      // Bucket "1": CVR_up=[2,1] ⇒ K²=5+1=6 (ρ²=0.25); CVR_down=[-1,-1] ψ=0 ⇒ K²=2.
      { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: 2, cvr_down: -1 } },
      { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: 1, cvr_down: -1 } },
      // Bucket "2": CVR_up=[-2,-1] ψ=0 ⇒ K²=5; CVR_down=[3,2] ψ=1 ⇒ K²=13+3=16 ⇒ K=4.
      { sensitivity_type: "Curvature", bucket: "2", risk_value: { cvr_up: -2, cvr_down: 3 } },
      { sensitivity_type: "Curvature", bucket: "2", risk_value: { cvr_up: -1, cvr_down: 2 } },
    ];
    const out = computeEquityCurvatureCharge(rows, {
      intraBucketRhoDelta: 0.5, // ρ_curv = 0.25
      crossBucketGammaDelta: { kind: "constant", value: 0.5 }, // γ_curv = 0.25
    });
    const b1 = out.perBucket.find((p) => p.bucket === "1")!;
    const b2 = out.perBucket.find((p) => p.bucket === "2")!;
    expect(b1.K_b).toBeCloseTo(Math.sqrt(6), 12);
    expect(b1.direction).toBe("up");
    expect(b1.S_b).toBeCloseTo(3, 12);
    expect(b2.K_b).toBeCloseTo(4, 12);
    expect(b2.direction).toBe("down");
    expect(b2.S_b).toBeCloseTo(5, 12);
    // sumK2=22; cross=2·0.25·3·5=7.5; charge=√29.5.
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(29.5), 12);
    expect(out.direction).toBe("mixed");
  });

  it("ignores non-Curvature rows and returns zeros for an empty input", () => {
    const out = computeEquityCurvatureCharge(
      [{ sensitivity_type: "Delta", bucket: "1", risk_value: { cvr_up: 9, cvr_down: -9 } }],
      { intraBucketRhoDelta: 0.5, crossBucketGammaDelta: { kind: "constant", value: 0 } },
    );
    expect(out.perBucket).toHaveLength(0);
    expect(out.riskClassCharge).toBe(0);
  });
});
