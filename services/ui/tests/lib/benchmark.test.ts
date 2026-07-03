import { describe, it, expect } from "vitest";
import {
  BENCHMARK_ROW_TIERS,
  benchmarkTiersUpTo,
  buildBenchmarkPlan,
  formatBenchmarkRows,
  formatBenchmarkWallMs,
  resolveBenchmarkPortfolioRows,
  runnableBenchmarkSteps,
  selectBucketCellsForTarget,
  snapPortfolioTier,
  type BucketFacetRow,
} from "../../src/lib/benchmark";

const SAMPLE_FACETS: BucketFacetRow[] = [
  { risk_class: "GIRR", bucket: "EUR", count: 40_000_000 },
  { risk_class: "GIRR", bucket: "USD", count: 40_000_000 },
  { risk_class: "EQUITY", bucket: "1", count: 10_000_000 },
  { risk_class: "EQUITY", bucket: "2", count: 10_000_000 },
  { risk_class: "FX", bucket: "EURUSD", count: 40_000_000 },
];

describe("resolveBenchmarkPortfolioRows", () => {
  it("uses facet sum when bucket facets are available", () => {
    const r = resolveBenchmarkPortfolioRows(
      { rows: 500_000_000, source: "Redis key count (approx)" },
      SAMPLE_FACETS,
    );
    expect(r.rows).toBe(140_000_000);
    expect(r.source).toContain("bucket facets");
  });
});

const UNIFORM_FACETS: BucketFacetRow[] = [
  { risk_class: "GIRR", bucket: "USD", count: 100_000_000 },
  { risk_class: "GIRR", bucket: "EUR", count: 100_000_000 },
  { risk_class: "EQUITY", bucket: "1", count: 100_000_000 },
  { risk_class: "FX", bucket: "EURUSD", count: 100_000_000 },
];

describe("selectBucketCellsForTarget", () => {
  it("uses tier-proportional bucket counts when row counts are uniform", () => {
    const s0 = selectBucketCellsForTarget(UNIFORM_FACETS, 10_000_000, {
      tierIndex: 0,
      tierCount: 5,
      proportionalByTier: true,
    });
    const s2 = selectBucketCellsForTarget(UNIFORM_FACETS, 100_000_000, {
      tierIndex: 2,
      tierCount: 5,
      proportionalByTier: true,
    });
    expect(s0.cells).toHaveLength(1);
    expect(s2.cells.length).toBeGreaterThan(s0.cells.length);
    expect(s2.cells.slice(0, s0.cells.length)).toEqual(s0.cells);
  });

  it("picks smallest buckets first for tighter approximations when counts vary", () => {
    const s10 = selectBucketCellsForTarget(SAMPLE_FACETS, 10_000_000);
    expect(s10.selectedRows).toBe(10_000_000);
    expect(s10.cells).toEqual([{ risk_class: "EQUITY", bucket: "1" }]);
  });

  it("returns nested subsets for increasing targets", () => {
    const s10 = selectBucketCellsForTarget(SAMPLE_FACETS, 10_000_000);
    expect(s10.isFull).toBe(false);
    expect(s10.cells).toEqual([{ risk_class: "EQUITY", bucket: "1" }]);

    const s50 = selectBucketCellsForTarget(SAMPLE_FACETS, 50_000_000);
    expect(s50.cells.length).toBeGreaterThan(s10.cells.length);
    expect(s50.cells.slice(0, s10.cells.length)).toEqual(s10.cells);
  });

  it("returns full portfolio when target exceeds total", () => {
    const full = selectBucketCellsForTarget(SAMPLE_FACETS, 400_000_000);
    expect(full.isFull).toBe(true);
    expect(full.cells).toEqual([]);
    expect(full.selectedRows).toBe(140_000_000);
  });
});

describe("buildBenchmarkPlan", () => {
  it("uses proportional subsets for approximate uniform facets", () => {
    const steps = buildBenchmarkPlan(400_000_000, UNIFORM_FACETS, {
      bucketCountsApproximate: true,
    });
    const bucketCounts = steps.map((s) => s.bucket_cells.length);
    expect(new Set(bucketCounts).size).toBeGreaterThan(1);
  });

  it("marks all tiers runnable with bucket subsets when facets exist", () => {
    const steps = buildBenchmarkPlan(400_000_000, SAMPLE_FACETS);
    expect(steps).toHaveLength(5);
    expect(runnableBenchmarkSteps(steps)).toHaveLength(5);
    expect(steps[0]!.bucket_cells.length).toBeGreaterThan(0);
    expect(steps[4]!.bucket_cells).toEqual([]);
  });

  it("falls back to single full run when facets are unavailable", () => {
    const steps = buildBenchmarkPlan(10_000_000, []);
    expect(runnableBenchmarkSteps(steps)).toHaveLength(1);
  });
});

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
  });
});

describe("snapPortfolioTier", () => {
  it("snaps down to the nearest ladder label", () => {
    expect(snapPortfolioTier(12_000_000)).toBe(10_000_000);
    expect(snapPortfolioTier(400_000_000)).toBe(400_000_000);
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
