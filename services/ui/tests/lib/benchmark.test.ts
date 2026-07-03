import { describe, it, expect } from "vitest";
import {
  BENCHMARK_ROW_TIERS,
  benchmarkTiersUpTo,
  buildBenchmarkPlan,
  formatBenchmarkRows,
  formatBenchmarkWallMs,
  runnableBenchmarkSteps,
  snapPortfolioTier,
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

describe("snapPortfolioTier", () => {
  it("snaps down to the nearest ladder label", () => {
    expect(snapPortfolioTier(12_000_000)).toBe(10_000_000);
    expect(snapPortfolioTier(400_000_000)).toBe(400_000_000);
    expect(snapPortfolioTier(3_000_000)).toBeNull();
  });
});

describe("buildBenchmarkPlan", () => {
  it("runs only the snapped tier on a 10M portfolio", () => {
    const steps = buildBenchmarkPlan(10_000_000);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ tier_rows: 10_000_000, runnable: true, status: "pending" });
    expect(runnableBenchmarkSteps(steps)).toHaveLength(1);
  });

  it("shows full ladder but only the top tier is runnable at 400M", () => {
    const steps = buildBenchmarkPlan(400_000_000);
    expect(steps).toHaveLength(5);
    expect(runnableBenchmarkSteps(steps)).toEqual([
      expect.objectContaining({ tier_rows: 400_000_000, runnable: true }),
    ]);
    expect(steps.filter((s) => s.status === "skipped")).toHaveLength(4);
  });

  it("snaps 120M portfolio to 100M runnable tier", () => {
    const steps = buildBenchmarkPlan(120_000_000);
    expect(steps.map((s) => s.tier_rows)).toEqual([10_000_000, 50_000_000, 100_000_000]);
    expect(runnableBenchmarkSteps(steps)).toEqual([
      expect.objectContaining({ tier_rows: 100_000_000, runnable: true }),
    ]);
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
