import { describe, it, expect } from "vitest";
import {
  CORRELATION_REGIME_FACTOR,
  reduceCurvatureCharge,
  reduceRiskClassCharge,
  scaleCorrelationSpec,
  type CorrelationSpec,
} from "../src/sbm/reduce.ts";
import { computeGirrCurvatureCharge } from "@frtb/calc/src/girrCurvatureReference.ts";
import { computeEquityCurvatureCharge } from "@frtb/calc/src/equityCurvatureReference.ts";
import { computeFxCurvatureCharge } from "@frtb/calc/src/fxCurvatureReference.ts";

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

// §21.5(5) cross-bucket Curvature aggregation. The api layer rolls up
// per-bucket {K_b, S_b} produced by the FCALL (girr_curvature /
// equity_curvature / fx_curvature). To anchor the api's reduce step against
// the source-of-truth math we drive each fixture through the calc-side
// reference oracle (which exercises the full §21.5(3)+(5) chain end-to-end),
// extract its per-bucket K_b/S_b, feed them into reduceCurvatureCharge with
// the same Delta γ, and assert ±1e-9 agreement with the oracle's
// riskClassCharge. Coverage per fixture: positive-interior, all-negative S
// (exercises ψ=0 gating), mixed direction, fallback branch (§21.5(5)(b)),
// and a single-bucket sanity case.

describe("reduceCurvatureCharge — §21.5(5) + §21.5(5)(b) against the calc oracle", () => {
  // ---------- GIRR (multi-tenor CVR vector per row) ----------
  const girrFixtures: Array<{
    name: string;
    rows: Array<{ sensitivity_type: string; bucket: string; risk_value: unknown }>;
    rhoDelta: number;
    gammaDelta: number;
  }> = [
    {
      name: "GIRR positive-interior, two buckets",
      rows: [
        { sensitivity_type: "Curvature", bucket: "USD-IRS", risk_value: { cvr_up: [1, 2], cvr_down: [-0.5, -1] } },
        { sensitivity_type: "Curvature", bucket: "EUR-IRS", risk_value: { cvr_up: [0.5, 1.5], cvr_down: [-0.25, -0.75] } },
      ],
      rhoDelta: 0.5,
      gammaDelta: 0.3,
    },
    {
      name: "GIRR all-negative S triggers ψ=0 in cross term",
      rows: [
        { sensitivity_type: "Curvature", bucket: "A", risk_value: { cvr_up: [-1, -1], cvr_down: [0, 0] } },
        { sensitivity_type: "Curvature", bucket: "B", risk_value: { cvr_up: [-2, -1], cvr_down: [0, 0] } },
      ],
      rhoDelta: 0.5,
      gammaDelta: 0.6,
    },
    {
      name: "GIRR mixed direction across buckets (one picks up, one picks down)",
      rows: [
        { sensitivity_type: "Curvature", bucket: "A", risk_value: { cvr_up: [3, 0], cvr_down: [0, 0] } },
        { sensitivity_type: "Curvature", bucket: "B", risk_value: { cvr_up: [0, 0], cvr_down: [-3, 0] } },
      ],
      rhoDelta: 0.4,
      gammaDelta: 0.5,
    },
    {
      name: "GIRR fallback branch §21.5(5)(b) — interior < 0 forces clip-recompute",
      rows: [
        { sensitivity_type: "Curvature", bucket: "A", risk_value: { cvr_up: [10, 0], cvr_down: [0, 0] } },
        { sensitivity_type: "Curvature", bucket: "B", risk_value: { cvr_up: [-10, 0], cvr_down: [0, 0] } },
      ],
      rhoDelta: 0.99,
      gammaDelta: 0.99,
    },
    {
      name: "GIRR single bucket — γ irrelevant, K_b = oracle K_b",
      rows: [
        { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: [2, 1], cvr_down: [-0.5, -0.25] } },
      ],
      rhoDelta: 0.5,
      gammaDelta: 0.5,
    },
  ];

  it.each(girrFixtures)("$name", ({ rows, rhoDelta, gammaDelta }) => {
    const oracle = computeGirrCurvatureCharge(rows, {
      tenors: 2,
      intraBucketRhoDelta: rhoDelta,
      crossBucketGammaDelta: { kind: "constant", value: gammaDelta },
    });
    const per = oracle.perBucket.map((b) => ({
      bucket: b.bucket, K_b: b.K_b, S_b: b.S_b, count: b.count, ms: 0,
    }));
    const out = reduceCurvatureCharge(per, { kind: "constant", value: gammaDelta });
    expect(Math.abs(out.charge - oracle.riskClassCharge)).toBeLessThan(1e-9);
  });

  // ---------- Equity (scalar CVR per row — one row per issuer factor) ----------
  const equityFixtures = [
    {
      name: "Equity positive-interior, two buckets",
      rows: [
        { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: 0.6, cvr_down: -0.2 } },
        { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: 0.8, cvr_down: -0.3 } },
        { sensitivity_type: "Curvature", bucket: "2", risk_value: { cvr_up: 0.4, cvr_down: -0.1 } },
        { sensitivity_type: "Curvature", bucket: "2", risk_value: { cvr_up: 0.5, cvr_down: -0.15 } },
      ],
      rhoDelta: 0.15, gammaDelta: 0.2,
    },
    {
      name: "Equity all-negative S triggers ψ=0",
      rows: [
        { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: -0.5, cvr_down: 0 } },
        { sensitivity_type: "Curvature", bucket: "2", risk_value: { cvr_up: -0.8, cvr_down: 0 } },
      ],
      rhoDelta: 0.15, gammaDelta: 0.6,
    },
    {
      name: "Equity mixed direction across buckets",
      rows: [
        { sensitivity_type: "Curvature", bucket: "1", risk_value: { cvr_up: 1.0, cvr_down: 0 } },
        { sensitivity_type: "Curvature", bucket: "2", risk_value: { cvr_up: 0, cvr_down: -1.5 } },
      ],
      rhoDelta: 0.2, gammaDelta: 0.4,
    },
    {
      name: "Equity fallback branch §21.5(5)(b)",
      rows: [
        { sensitivity_type: "Curvature", bucket: "A", risk_value: { cvr_up: 5, cvr_down: 0 } },
        { sensitivity_type: "Curvature", bucket: "B", risk_value: { cvr_up: -5, cvr_down: 0 } },
      ],
      rhoDelta: 0.99, gammaDelta: 0.99,
    },
  ];

  it.each(equityFixtures)("$name", ({ rows, rhoDelta, gammaDelta }) => {
    const oracle = computeEquityCurvatureCharge(rows, {
      intraBucketRhoDelta: rhoDelta,
      crossBucketGammaDelta: { kind: "constant", value: gammaDelta },
    });
    const per = oracle.perBucket.map((b) => ({
      bucket: b.bucket, K_b: b.K_b, S_b: b.S_b, count: b.count, ms: 0,
    }));
    const out = reduceCurvatureCharge(per, { kind: "constant", value: gammaDelta });
    expect(Math.abs(out.charge - oracle.riskClassCharge)).toBeLessThan(1e-9);
  });

  // ---------- FX (scalar CVR per currency pair) ----------
  const fxFixtures = [
    {
      name: "FX positive-interior, multiple pairs",
      rows: [
        { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 0.4, cvr_down: -0.2 } },
        { sensitivity_type: "Curvature", bucket: "GBPUSD", risk_value: { cvr_up: 0.5, cvr_down: -0.15 } },
        { sensitivity_type: "Curvature", bucket: "JPYUSD", risk_value: { cvr_up: 0.3, cvr_down: -0.1 } },
      ],
      gammaDelta: 0.6,
    },
    {
      name: "FX all-negative S triggers ψ=0",
      rows: [
        { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: -0.3, cvr_down: 0 } },
        { sensitivity_type: "Curvature", bucket: "GBPUSD", risk_value: { cvr_up: -0.4, cvr_down: 0 } },
      ],
      gammaDelta: 0.6,
    },
    {
      name: "FX mixed direction across buckets",
      rows: [
        { sensitivity_type: "Curvature", bucket: "EURUSD", risk_value: { cvr_up: 0.8, cvr_down: 0 } },
        { sensitivity_type: "Curvature", bucket: "GBPUSD", risk_value: { cvr_up: 0, cvr_down: -0.6 } },
      ],
      gammaDelta: 0.5,
    },
    {
      name: "FX fallback branch §21.5(5)(b)",
      rows: [
        { sensitivity_type: "Curvature", bucket: "A", risk_value: { cvr_up: 4, cvr_down: 0 } },
        { sensitivity_type: "Curvature", bucket: "B", risk_value: { cvr_up: -4, cvr_down: 0 } },
      ],
      gammaDelta: 0.99,
    },
  ];

  it.each(fxFixtures)("$name", ({ rows, gammaDelta }) => {
    const oracle = computeFxCurvatureCharge(rows, {
      crossBucketGammaDelta: { kind: "constant", value: gammaDelta },
    });
    const per = oracle.perBucket.map((b) => ({
      bucket: b.bucket, K_b: b.K_b, S_b: b.S_b, count: b.count, ms: 0,
    }));
    const out = reduceCurvatureCharge(per, { kind: "constant", value: gammaDelta });
    expect(Math.abs(out.charge - oracle.riskClassCharge)).toBeLessThan(1e-9);
  });

  it("empty bucket list returns { charge: 0, usedFallback: false }", () => {
    expect(reduceCurvatureCharge([], { kind: "constant", value: 0.5 })).toEqual({
      charge: 0,
      usedFallback: false,
    });
  });

  // §21.5(5)(b) fallback propagation: when ΣK_b² + Σγ²·S·S·ψ is negative the
  // shared kernel re-runs with S_b clipped into [-K_b, +K_b]. We feed
  // synthesised per-bucket inputs that pin the interior negative — small K_b
  // alongside mixed-sign S_b (one strongly positive, one strongly negative)
  // and γ_delta near 1 so γ_curv = γ_delta² is large enough to dominate.
  // ψ(S_A, S_B) = 1 because they have opposite signs (only ψ=0 when BOTH are
  // strictly negative), so the cross term is preserved at its full magnitude.
  it("propagates usedFallback=true when §21.5(5) interior is negative", () => {
    const per: Array<{ bucket: string; K_b: number; S_b: number; count: number; ms: number }> = [
      { bucket: "A", K_b: 1, S_b: 10, count: 1, ms: 0 },
      { bucket: "B", K_b: 1, S_b: -10, count: 1, ms: 0 },
    ];
    // γ_delta=0.99 → γ_curv = 0.9801. Cross = 2·(0.9801·10·-10·ψ) = -196.02.
    // ΣK² = 2 → interior = -194.02 < 0 → fallback fires. Clipped S = ±1, so
    // cross+ = 2·(0.9801·1·-1·ψ) = -1.9602 → sumAlt = 0.0398 → charge ≈ 0.1995.
    const out = reduceCurvatureCharge(per, { kind: "constant", value: 0.99 });
    expect(out.usedFallback).toBe(true);
    expect(out.charge).toBeCloseTo(Math.sqrt(0.0398), 6);
  });

  it("reports usedFallback=false when §21.5(5) interior is non-negative", () => {
    const per: Array<{ bucket: string; K_b: number; S_b: number; count: number; ms: number }> = [
      { bucket: "A", K_b: 2, S_b: 1, count: 1, ms: 0 },
      { bucket: "B", K_b: 2, S_b: 1, count: 1, ms: 0 },
    ];
    const out = reduceCurvatureCharge(per, { kind: "constant", value: 0.5 });
    expect(out.usedFallback).toBe(false);
    expect(out.charge).toBeGreaterThan(0);
  });
});


// Wave 5.31b: §21.6 cross-bucket γ regime scaler. Pure, non-mutating helper
// that the route layer calls once per request before handing the spec to the
// reducer. Identity at factor=1.0 (the medium-regime fast path) and
// symmetric ±cap clamping for the high regime where γ can otherwise exceed 1.
describe("scaleCorrelationSpec — Basel §21.6 regime scaler", () => {
  it("returns the input reference unchanged when factor === 1.0", () => {
    const spec: CorrelationSpec = { kind: "constant", value: 0.5 };
    const out = scaleCorrelationSpec(spec, 1.0, 1.0);
    expect(out).toBe(spec);
  });

  it("scales a constant spec by the factor", () => {
    const out = scaleCorrelationSpec({ kind: "constant", value: 0.4 }, 0.75, 1.0);
    expect(out).toEqual({ kind: "constant", value: 0.4 * 0.75 });
  });

  it("scales a matrix spec element-wise without mutating the input", () => {
    const input: CorrelationSpec = {
      kind: "matrix",
      labels: ["A", "B"],
      matrix: [
        [1.0, 0.5],
        [0.5, 1.0],
      ],
    };
    const out = scaleCorrelationSpec(input, 0.75, 1.0);
    // 0.5 × 0.75 = 0.375 (exactly representable in IEEE 754) avoids the FP
    // drift you get from e.g. 0.4 × 0.75 = 0.30000000000000004.
    expect(out).toEqual({
      kind: "matrix",
      labels: ["A", "B"],
      matrix: [
        [0.75, 0.375],
        [0.375, 0.75],
      ],
    });
    // Input must NOT be mutated — the route layer holds a long-lived reference
    // to the YAML-loaded spec and a second request would otherwise see drift.
    expect(input.matrix).toEqual([
      [1.0, 0.5],
      [0.5, 1.0],
    ]);
    expect(out).not.toBe(input);
  });

  it("caps high-regime overflow at 1.0 (0.95 × 1.25 = 1.1875 → 1.0)", () => {
    const out = scaleCorrelationSpec({ kind: "constant", value: 0.95 }, 1.25, 1.0);
    expect(out).toEqual({ kind: "constant", value: 1.0 });
  });

  it("clamps negative ρ symmetrically at -1.0 (-0.95 × 1.25 → -1.0)", () => {
    const out = scaleCorrelationSpec({ kind: "constant", value: -0.95 }, 1.25, 1.0);
    expect(out).toEqual({ kind: "constant", value: -1.0 });
  });

  it("matrix high-regime: per-cell cap and no input mutation", () => {
    const input: CorrelationSpec = {
      kind: "matrix",
      labels: ["A", "B"],
      matrix: [
        [1.0, 0.9],
        [0.9, 1.0],
      ],
    };
    const out = scaleCorrelationSpec(input, 1.25, 1.0);
    expect(out).toEqual({
      kind: "matrix",
      labels: ["A", "B"],
      matrix: [
        [1.0, 1.0],
        [1.0, 1.0],
      ],
    });
    expect(input.matrix[0]![1]).toBe(0.9);
  });

  it("CORRELATION_REGIME_FACTOR pins the Basel §21.6 numeric scalers", () => {
    expect(CORRELATION_REGIME_FACTOR.low).toBe(0.75);
    expect(CORRELATION_REGIME_FACTOR.medium).toBe(1.0);
    expect(CORRELATION_REGIME_FACTOR.high).toBe(1.25);
  });
});
