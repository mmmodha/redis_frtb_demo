import { describe, it, expect } from "vitest";
import { formatCharge } from "../../src/lib/format";

describe("formatCharge (Wave 5.18 magnitude-aware formatter)", () => {
  it("returns 0.6846 for 0.6846307166088303 (sub-1 → 4 decimals)", () => {
    expect(formatCharge(0.6846307166088303)).toBe("0.6846");
  });

  it("returns 9,495.23 for 9495.234078557116 (>=100 → 2 decimals, thousands-grouped)", () => {
    expect(formatCharge(9495.234078557116)).toBe("9,495.23");
  });

  it("uses 3 decimals for 1 <= |n| < 100", () => {
    expect(formatCharge(52.060123)).toBe("52.060");
  });

  it("preserves sign for negative values", () => {
    expect(formatCharge(-0.1556)).toBe("-0.1556");
  });
});
