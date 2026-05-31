import { describe, it, expect } from "vitest";
import { computeGirrCurvatureCharge } from "../src/girrCurvatureReference.ts";

// Pure-TS oracle for GIRR Curvature — MAR21 §21.5(2)–(3), §21.5(5), §21.5(5)(b).
// Shape A: each row carries pre-computed per-tenor CVR_k^+ / CVR_k^- arrays.
//   K_b^{+|-}² = Σ_k CVR_k² + Σ_{k≠l} ρ² · CVR_k · CVR_l · ψ(.)        §21.5(3)
//   K_b = max(K_b^+, K_b^-)                                              §21.5(3)
//   S_b = Σ_k CVR_k  of the winning direction                            §21.5(5)
//   charge = √max(0, Σ_b K_b² + Σ_{b≠c} γ² · S_b · S_c · ψ(S_b, S_c))    §21.5(5)
//   §21.5(5)(b) fallback: when interior < 0, clip S_b ∈ [-K_b, K_b].
//   ρ_curv = ρ_delta², γ_curv = γ_delta² (auto-derived).

describe("computeGirrCurvatureCharge (TS reference oracle)", () => {
  it("single bucket, two tenors, positive interior — K_b^+ and K_b^- match hand-computed (ρ_delta=0.5, ρ²=0.25)", () => {
    // CVR_up = [1, 2]; CVR_down = [-0.5, -1] (both negative ⇒ ψ=0).
    const rows = [
      {
        sensitivity_type: "Curvature",
        bucket: "1",
        risk_value: { cvr_up: [1, 2], cvr_down: [-0.5, -1] },
      },
    ];
    const out = computeGirrCurvatureCharge(rows, {
      tenors: 2,
      intraBucketRhoDelta: 0.5, // ρ_curv = 0.25  §21.5(3)
      crossBucketGammaDelta: { kind: "constant", value: 0 },
    });
    expect(out.perBucket).toHaveLength(1);
    const b = out.perBucket[0]!;
    expect(b.bucket).toBe("1");
    expect(b.count).toBe(1);
    // K_b_up² = 1² + 2² + 0.25·(1·2 + 2·1) = 5 + 1 = 6.
    expect(b.K_b_up).toBeCloseTo(Math.sqrt(6), 12);
    // K_b_down² = 0.25 + 1 + 0 (ψ(-0.5,-1)=0) = 1.25.
    expect(b.K_b_down).toBeCloseTo(Math.sqrt(1.25), 12);
    expect(b.K_b).toBeCloseTo(Math.sqrt(6), 12);
    expect(b.direction).toBe("up");
    expect(b.S_b).toBeCloseTo(3, 12);
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(6), 12);
    expect(out.direction).toBe("up");
    expect(out.usedFallback).toBe(false);
  });

  it("aggregates per-tenor CVR additively across rows in the same bucket (mirrors Delta)", () => {
    const rows = [
      {
        sensitivity_type: "Curvature",
        bucket: "1",
        risk_value: { cvr_up: [0.5, 1.0], cvr_down: [-0.25, -0.5] },
      },
      {
        sensitivity_type: "Curvature",
        bucket: "1",
        risk_value: { cvr_up: [0.5, 1.0], cvr_down: [-0.25, -0.5] },
      },
    ];
    const out = computeGirrCurvatureCharge(rows, {
      tenors: 2,
      intraBucketRhoDelta: 0.5,
      crossBucketGammaDelta: { kind: "constant", value: 0 },
    });
    // Summed CVR_up = [1, 2], CVR_down = [-0.5, -1] — matches the single-row case above.
    expect(out.perBucket[0]!.count).toBe(2);
    expect(out.perBucket[0]!.K_b).toBeCloseTo(Math.sqrt(6), 12);
    expect(out.perBucket[0]!.S_b).toBeCloseTo(3, 12);
  });

  it("triggers §21.5(5)(b) fallback when sum_K2 + cross < 0 (ρ_delta=γ_delta=1)", () => {
    // Two buckets with K_b^up = √18 / 6 and S_b = -6 / +6 ⇒ cross-bucket sum < 0.
    const rows = [
      // Bucket "A": CVR_up=[-3,-3] ⇒ ψ(-3,-3)=0 ⇒ K_b²=18; CVR_down=[0,0] ⇒ K_b=0.
      {
        sensitivity_type: "Curvature",
        bucket: "A",
        risk_value: { cvr_up: [-3, -3], cvr_down: [0, 0] },
      },
      // Bucket "B": CVR_up=[3,3] ⇒ ψ=1 ⇒ K_b²=18+18=36 ⇒ K_b=6; CVR_down=[0,0] ⇒ K_b=0.
      {
        sensitivity_type: "Curvature",
        bucket: "B",
        risk_value: { cvr_up: [3, 3], cvr_down: [0, 0] },
      },
    ];
    const out = computeGirrCurvatureCharge(rows, {
      tenors: 2,
      intraBucketRhoDelta: 1, // ρ_curv = 1
      crossBucketGammaDelta: { kind: "constant", value: 1 }, // γ_curv = 1
    });
    const A = out.perBucket.find((p) => p.bucket === "A")!;
    const B = out.perBucket.find((p) => p.bucket === "B")!;
    expect(A.K_b).toBeCloseTo(Math.sqrt(18), 12);
    expect(A.S_b).toBeCloseTo(-6, 12);
    expect(B.K_b).toBeCloseTo(6, 12);
    expect(B.S_b).toBeCloseTo(6, 12);
    // sumK2 = 18 + 36 = 54; cross = 2·(-6)·6·1 = -72; sum = -18 < 0 ⇒ fallback.
    // Clip S_A ∈ [-√18, √18] ⇒ -√18; clip S_B ∈ [-6, 6] ⇒ 6.
    // cross_alt = 2·(-√18)·6·1 = -12·√18; sum_alt = 54 - 12·√18.
    expect(out.usedFallback).toBe(true);
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(54 - 12 * Math.sqrt(18)), 12);
    expect(out.direction).toBe("up");
  });

  it("multi-bucket γ² cross aggregation with mixed up/down winners per bucket", () => {
    const rows = [
      // Bucket "1": CVR_up=[2,1] (positive) ⇒ K²=5+1=6 ⇒ K=√6; CVR_down=[-1,-1] (ψ=0) ⇒ K²=2.
      {
        sensitivity_type: "Curvature",
        bucket: "1",
        risk_value: { cvr_up: [2, 1], cvr_down: [-1, -1] },
      },
      // Bucket "2": CVR_up=[-2,-1] (ψ=0) ⇒ K²=5; CVR_down=[3,2] (ψ=1) ⇒ K²=13+3=16 ⇒ K=4.
      {
        sensitivity_type: "Curvature",
        bucket: "2",
        risk_value: { cvr_up: [-2, -1], cvr_down: [3, 2] },
      },
    ];
    const out = computeGirrCurvatureCharge(rows, {
      tenors: 2,
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
    // sumK2 = 6 + 16 = 22; cross = 2·0.25·3·5 = 7.5; charge = √29.5.
    expect(out.riskClassCharge).toBeCloseTo(Math.sqrt(29.5), 12);
    expect(out.direction).toBe("mixed");
    expect(out.usedFallback).toBe(false);
  });

  it("ignores non-Curvature rows and returns zeros for an empty input", () => {
    const out = computeGirrCurvatureCharge(
      [
        { sensitivity_type: "Delta", bucket: "1", risk_value: { cvr_up: [9, 9], cvr_down: [-9, -9] } },
        { sensitivity_type: "Vega", bucket: "1", risk_value: { cvr_up: [9, 9], cvr_down: [-9, -9] } },
      ],
      { tenors: 2, intraBucketRhoDelta: 0.5, crossBucketGammaDelta: { kind: "constant", value: 0 } },
    );
    expect(out.perBucket).toHaveLength(0);
    expect(out.riskClassCharge).toBe(0);
    expect(out.usedFallback).toBe(false);
  });
});
