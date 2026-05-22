import { describe, it, expect } from "vitest";
import { computeKbVega } from "../src/girrVegaReference.ts";

// Pure-TS reference (oracle) for the Vega K_b math per CRE22.62.
// Used by integration tests and downstream cross-check tooling.
describe("computeKbVega (TS reference oracle)", () => {
  it("equals √(ΣWS² + ρ·((ΣWS)² − ΣWS²)) for constant w & ρ", () => {
    const rows = [[0.5, 1.0], [1.0, 0.5]];
    const out = computeKbVega(rows, 1.0, 0.5);
    expect(out.K_b).toBeCloseTo(Math.sqrt(5.75), 12);
    expect(out.S_b).toBeCloseTo(3.0, 12);
    expect(out.count).toBe(2);
  });

  it("collapses to √ΣWS² when ρ=0", () => {
    const out = computeKbVega([[0.3, 0.4]], 1.0, 0.0);
    expect(out.K_b).toBeCloseTo(0.5, 12);
  });

  it("scales linearly with weight", () => {
    const a = computeKbVega([[1, 2, 3]], 1.0, 0.2);
    const b = computeKbVega([[1, 2, 3]], 2.0, 0.2);
    expect(b.K_b).toBeCloseTo(2 * a.K_b, 12);
    expect(b.S_b).toBeCloseTo(2 * a.S_b, 12);
  });

  it("returns zeros for an empty bucket", () => {
    const out = computeKbVega([], 0.18, 0.4);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
    expect(out.count).toBe(0);
  });
});
