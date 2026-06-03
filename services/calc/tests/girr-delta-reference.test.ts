import { describe, it, expect } from "vitest";
import { computeKbDelta } from "../src/girrDeltaReference.ts";

// Pure-TS oracle for GIRR Delta K_b — MAR21 §21.4(2)–(4) / Basel CRE22.30.
//   WS_k = w_k · s_k     (per-tenor weighted sensitivity)
//   K_b  = √(ΣΣ ρ_kl · WS_k · WS_l)   (ρ_kk=1, ρ_kl=ρ for k≠l)
//   S_b  = Σ WS_k

const GIRR_W = [0.017, 0.017, 0.016, 0.013, 0.012, 0.011, 0.011, 0.011, 0.011, 0.011];

describe("computeKbDelta (TS reference oracle)", () => {
  it("computes WS per tenor and K_b for a hand-computed single-row fixture (ρ=0.99)", () => {
    const rows = [{ sensitivity_type: "Delta", risk_value: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }];
    const out = computeKbDelta(rows, GIRR_W, 0.99);

    // Expected WS_k = w_k * (k+1)
    const expectedWS = GIRR_W.map((w, i) => w * (i + 1));
    for (let k = 0; k < 10; k++) expect(out.WS[k]).toBeCloseTo(expectedWS[k]!, 12);

    // K_b² = ΣWS² + ρ·((ΣWS)² − ΣWS²)
    const sumWs = expectedWS.reduce((a, b) => a + b, 0);
    const sumWsSq = expectedWS.reduce((a, b) => a + b * b, 0);
    const expectedK = Math.sqrt(sumWsSq + 0.99 * (sumWs * sumWs - sumWsSq));
    expect(out.K_b).toBeCloseTo(expectedK, 12);
    expect(out.S_b).toBeCloseTo(sumWs, 12);
    expect(out.count).toBe(1);
  });

  it("aggregates WS additively across multiple Delta rows in the same bucket", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      { sensitivity_type: "Delta", risk_value: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] },
    ];
    const out = computeKbDelta(rows, GIRR_W, 0.99);
    expect(out.count).toBe(2);
    // s1+s2 = 11 for every tenor
    for (let k = 0; k < 10; k++) expect(out.WS[k]).toBeCloseTo(GIRR_W[k]! * 11, 12);
  });

  it("ignores non-Delta sensitivity types (Vega / Curvature filtered)", () => {
    const rows = [
      { sensitivity_type: "Delta", risk_value: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { sensitivity_type: "Vega", risk_value: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9] },
      { sensitivity_type: "Curvature", risk_value: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9] },
    ];
    const out = computeKbDelta(rows, GIRR_W, 0.99);
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(GIRR_W[0]!, 12);
    expect(out.S_b).toBeCloseTo(GIRR_W[0]!, 12);
  });

  it("collapses to √ΣWS² when ρ=0", () => {
    const rows = [{ sensitivity_type: "Delta", risk_value: [3, 4, 0, 0, 0, 0, 0, 0, 0, 0] }];
    const w = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const out = computeKbDelta(rows, w, 0);
    expect(out.K_b).toBeCloseTo(5, 12); // √(3²+4²)
  });

  it("equals ΣWS when ρ=1 (perfect correlation)", () => {
    const rows = [{ sensitivity_type: "Delta", risk_value: [3, 4, 0, 0, 0, 0, 0, 0, 0, 0] }];
    const w = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const out = computeKbDelta(rows, w, 1);
    expect(out.K_b).toBeCloseTo(7, 12);
  });

  it("returns zeros for an empty bucket", () => {
    const out = computeKbDelta([], GIRR_W, 0.99);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
    expect(out.count).toBe(0);
  });

  it("skips non-finite tenor entries without contaminating WS", () => {
    const rows = [{ sensitivity_type: "Delta", risk_value: [1, NaN, 3, 4, 5, 6, 7, 8, 9, 10] }];
    const out = computeKbDelta(rows, GIRR_W, 0.99);
    expect(out.WS[1]).toBe(0);
    expect(out.WS[0]).toBeCloseTo(GIRR_W[0]!, 12);
  });

  // Wave 5.52 — sparse per-tenor object inputs (variable-length risk_value
  // emitted by the new generator). Missing keys must contribute 0 to WS so
  // the kernel and reference oracle agree on the resulting K_b.
  describe("Wave 5.52: sparse per-tenor object", () => {
    const GIRR_TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"];

    it("missing keys are treated as 0 sensitivity (K_b matches hand-computed value)", () => {
      // Only two tenors populated: 3M=1, 10Y=2. All other tenors absent.
      const rows = [{ sensitivity_type: "Delta", risk_value: { "3M": 1, "10Y": 2 } }];
      const out = computeKbDelta(rows, GIRR_W, 0.99, GIRR_TENORS);
      const ws3m = GIRR_W[0]! * 1;     // 0.017 * 1
      const ws10y = GIRR_W[6]! * 2;    // 0.011 * 2
      expect(out.WS[0]).toBeCloseTo(ws3m, 12);
      expect(out.WS[6]).toBeCloseTo(ws10y, 12);
      // Other tenors zeroed out.
      for (const k of [1, 2, 3, 4, 5, 7, 8, 9]) expect(out.WS[k]).toBe(0);
      const sumWs = ws3m + ws10y;
      const sumWsSq = ws3m * ws3m + ws10y * ws10y;
      const expectedKb = Math.sqrt(sumWsSq + 0.99 * (sumWs * sumWs - sumWsSq));
      expect(out.K_b).toBeCloseTo(expectedKb, 12);
      expect(out.S_b).toBeCloseTo(sumWs, 12);
      expect(out.count).toBe(1);
    });

    it("sparse object with K=5 populated keys aggregates against a dense fixture row", () => {
      const dense = { "3M": 1, "6M": 2, "1Y": 3, "2Y": 4, "3Y": 5, "5Y": 6, "10Y": 7, "15Y": 8, "20Y": 9, "30Y": 10 };
      const sparse = { "3M": 1, "1Y": 3, "5Y": 6, "10Y": 7, "30Y": 10 };
      const rows = [
        { sensitivity_type: "Delta", risk_value: dense },
        { sensitivity_type: "Delta", risk_value: sparse },
      ];
      const out = computeKbDelta(rows, GIRR_W, 0.99, GIRR_TENORS);
      expect(out.count).toBe(2);
      // The 5 sparse-populated tenors should have doubled sums; the others
      // only carry the dense row's contribution.
      const expectedSums = GIRR_TENORS.map((t, i) => {
        const dv = (dense as Record<string, number>)[t] ?? 0;
        const sv = (sparse as Record<string, number>)[t] ?? 0;
        return GIRR_W[i]! * (dv + sv);
      });
      for (let k = 0; k < GIRR_TENORS.length; k++) {
        expect(out.WS[k]).toBeCloseTo(expectedSums[k]!, 12);
      }
    });
  });

  // Wave 5.31c — exclude predicate. Rows matching any of the book / trade_id
  // / risk_factor sets are dropped BEFORE contributing to WS / count, mirror
  // of the Lua kernel's `_frtb_excluded` short-circuit. Order of check is
  // book → trade_id → risk_factor (cheapest-cardinality first).
  describe("Wave 5.31c: exclude predicate", () => {
    it("drops rows whose book matches the exclude.book set", () => {
      const rows = [
        { sensitivity_type: "Delta", risk_value: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], book: "A" },
        { sensitivity_type: "Delta", risk_value: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0], book: "B" },
        { sensitivity_type: "Delta", risk_value: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0], book: "C" },
      ];
      const out = computeKbDelta(rows, GIRR_W, 0.99, undefined, { book: new Set(["B"]) });
      expect(out.count).toBe(2);
      // sum_s[0] = 1 + 4 = 5 → WS[0] = 0.017 * 5
      expect(out.WS[0]).toBeCloseTo(GIRR_W[0]! * 5, 12);
    });

    it("empty exclude (undefined) is byte-identical to omitting the parameter", () => {
      const rows = [
        { sensitivity_type: "Delta", risk_value: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], book: "A" },
        { sensitivity_type: "Delta", risk_value: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], book: "B" },
      ];
      const a = computeKbDelta(rows, GIRR_W, 0.99);
      const b = computeKbDelta(rows, GIRR_W, 0.99, undefined, undefined);
      const c = computeKbDelta(rows, GIRR_W, 0.99, undefined, {});
      expect(a.K_b).toBeCloseTo(b.K_b, 15);
      expect(a.K_b).toBeCloseTo(c.K_b, 15);
      expect(a.count).toBe(b.count);
      expect(a.count).toBe(c.count);
    });

    it("trade_id and risk_factor sets also drop matching rows", () => {
      const rows = [
        { sensitivity_type: "Delta", risk_value: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], trade_id: "T1", risk_factor: "F1" },
        { sensitivity_type: "Delta", risk_value: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0], trade_id: "T2", risk_factor: "F2" },
        { sensitivity_type: "Delta", risk_value: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0], trade_id: "T3", risk_factor: "F3" },
      ];
      const outTrade = computeKbDelta(rows, GIRR_W, 0.99, undefined, { trade_id: new Set(["T2"]) });
      expect(outTrade.count).toBe(2);
      const outFactor = computeKbDelta(rows, GIRR_W, 0.99, undefined, { risk_factor: new Set(["F1", "F3"]) });
      expect(outFactor.count).toBe(1);
    });
  });
});
