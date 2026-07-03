import { describe, it, expect } from "vitest";
import {
  BENCHMARK_ROW_TIERS,
  benchmarkTiersUpTo,
  formatBenchmarkRows,
  formatBenchmarkWallMs,
  initialBenchmarkSteps,
} from "../../src/lib/benchmark";

describe("benchmarkTiersUpTo", () => {
  it("returns empty when portfolio is unknown", () => {
    expect(benchmarkTiersUpTo(0)).toEqual([]);
  });

  it("caps ladder at detected row count", () => {
    expect(benchmarkTiersUpTo(120_000_000)).toEqual([
      10_000_000,
      50_000_000,
      100_000_000,
    ]);
  });

  it("includes full ladder at 400M+", () => {
    expect(benchmarkTiersUpTo(400_000_000)).toEqual([...BENCHMARK_ROW_TIERS]);
    expect(benchmarkTiersUpTo(900_000_000)).toEqual([...BENCHMARK_ROW_TIERS]);
  });
});

describe("formatBenchmarkRows", () => {
  it("formats millions", () => {
    expect(formatBenchmarkRows(10_000_000)).toBe("10M");
    expect(formatBenchmarkRows(400_000_000)).toBe("400M");
  });
});

describe("formatBenchmarkWallMs", () => {
  it("formats seconds and minutes", () => {
    expect(formatBenchmarkWallMs(38_200)).toBe("38.20 s");
    expect(formatBenchmarkWallMs(null)).toBe("—");
  });
});

describe("initialBenchmarkSteps", () => {
  it("creates pending rows for each tier", () => {
    const steps = initialBenchmarkSteps([10_000_000, 50_000_000]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ tier_rows: 10_000_000, status: "pending" });
  });
});
