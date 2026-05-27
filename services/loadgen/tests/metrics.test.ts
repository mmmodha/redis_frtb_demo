// RED — percentile helper used by the live SSE export.
//
// Contract: `percentile(samples, q)` returns 0 for an empty reservoir, the
// linear-interpolated value at quantile `q ∈ [0,1]` otherwise. Implementation
// is intentionally simple — the demo cluster's load test reservoir stays well
// under 50k samples per endpoint, so a sort-then-index approach is plenty.

import { describe, it, expect } from "vitest";
import { percentile } from "../src/metrics.ts";

describe("percentile", () => {
  it("returns 0 for an empty sample array", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.99)).toBe(0);
  });

  it("returns the only sample for a single-element array regardless of quantile", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });

  it("returns the median for a small sorted array", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBeCloseTo(3, 5);
  });

  it("returns p99 of a 100-element array close to the top value", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    const p99 = percentile(arr, 0.99);
    expect(p99).toBeGreaterThanOrEqual(99);
    expect(p99).toBeLessThanOrEqual(100);
  });

  it("does not mutate the input array", () => {
    const arr = [5, 3, 1, 4, 2];
    const snapshot = [...arr];
    percentile(arr, 0.95);
    expect(arr).toEqual(snapshot);
  });

  it("handles unsorted input correctly", () => {
    const arr = [5, 1, 3, 2, 4];
    expect(percentile(arr, 0.5)).toBeCloseTo(3, 5);
  });
});
