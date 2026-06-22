// Wave 7.0.4.B — unit tests for the per-shard deviation helper.
import { describe, it, expect } from "vitest";
import {
  computeShardDeviationFlags,
  computeShardDeviationRatios,
  DEFAULT_DEVIATION_THRESHOLD,
} from "../../src/lib/per-shard-deviation";
import type { PerShardRow } from "../../src/lib/api";

function row(id: string, write_ops_per_sec: number | null, overrides: Partial<PerShardRow> = {}): PerShardRow {
  return {
    shard_id: id,
    role: "master",
    memory_used: 0,
    key_count: null,
    write_ops_per_sec,
    index_lag: null,
    last_observed_at: null,
    snapshot_age_seconds: null,
    ...overrides,
  };
}

describe("computeShardDeviationFlags", () => {
  it("returns an empty set when every shard equals the mean", () => {
    const rows = [row("a", 1000), row("b", 1000), row("c", 1000)];
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec");
    expect(flags.size).toBe(0);
  });

  it("flags a single outlier that deviates >10% from the cluster mean", () => {
    // mean of [100, 100, 200] = 133.33; the 200-shard is (66.67/133.33)=0.50 → flagged.
    // The 100-shards are at 33.33/133.33 = 0.25 → also flagged (> 10%).
    const rows = [row("a", 100), row("b", 100), row("c", 200)];
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec");
    expect(flags.has("c")).toBe(true);
    expect(flags.has("a")).toBe(true);
    expect(flags.has("b")).toBe(true);
  });

  it("does NOT flag at exactly the threshold (strict greater-than)", () => {
    // mean=100, threshold=0.10 → a shard at 110 is exactly +10% → NOT flagged.
    const rows = [row("a", 90), row("b", 110)];
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec", 0.10);
    // mean is (90+110)/2 = 100; deviation 0.10 each, strict ">" => no flags.
    expect(flags.size).toBe(0);
  });

  it("flags shards just above the threshold", () => {
    const rows = [row("a", 89), row("b", 111)];
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec", 0.10);
    expect(flags.size).toBe(2);
  });

  it("returns empty when fewer than two shards", () => {
    expect(computeShardDeviationFlags([], "write_ops_per_sec").size).toBe(0);
    expect(computeShardDeviationFlags([row("a", 500)], "write_ops_per_sec").size).toBe(0);
  });

  it("ignores null samples for the chosen metric", () => {
    const rows = [row("a", 100), row("b", null), row("c", 200)];
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec");
    expect(flags.has("b")).toBe(false);
    // mean over the two finite samples = 150; both deviate by 33% → flagged.
    expect(flags.has("a")).toBe(true);
    expect(flags.has("c")).toBe(true);
  });

  it("returns empty when the cluster mean is zero", () => {
    const rows = [row("a", 0), row("b", 0), row("c", 0)];
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec");
    expect(flags.size).toBe(0);
  });

  it("excludes degraded fallback rows from the mean computation", () => {
    const rows = [
      row("aggregate", 1000, { degraded: true, shard_id: "aggregate" }),
      row("a", 100),
      row("b", 100),
    ];
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec");
    expect(flags.has("aggregate")).toBe(false);
    expect(flags.size).toBe(0);
  });

  it("uses the default 10% threshold when none is supplied", () => {
    const rows = [row("a", 100), row("b", 100), row("c", 130)];
    expect(DEFAULT_DEVIATION_THRESHOLD).toBe(0.10);
    const flags = computeShardDeviationFlags(rows, "write_ops_per_sec");
    expect(flags.has("c")).toBe(true);
  });

  it("works across other metrics (memory_used, key_count, index_lag)", () => {
    const rows: PerShardRow[] = [
      row("a", 0, { memory_used: 1_000_000_000, key_count: 1000, index_lag: 10 }),
      row("b", 0, { memory_used: 1_000_000_000, key_count: 1000, index_lag: 10 }),
      row("c", 0, { memory_used: 5_000_000_000, key_count: 5000, index_lag: 60 }),
    ];
    expect(computeShardDeviationFlags(rows, "memory_used").has("c")).toBe(true);
    expect(computeShardDeviationFlags(rows, "key_count").has("c")).toBe(true);
    expect(computeShardDeviationFlags(rows, "index_lag").has("c")).toBe(true);
  });
});

describe("computeShardDeviationRatios", () => {
  it("returns signed ratios per shard", () => {
    const rows = [row("a", 80), row("b", 120)];
    const ratios = computeShardDeviationRatios(rows, "write_ops_per_sec");
    expect(ratios.get("a")).toBeCloseTo(-0.20, 5);
    expect(ratios.get("b")).toBeCloseTo(0.20, 5);
  });

  it("returns empty map when mean is zero or fewer than 2 samples", () => {
    expect(computeShardDeviationRatios([row("a", 0), row("b", 0)], "write_ops_per_sec").size).toBe(0);
    expect(computeShardDeviationRatios([row("a", 100)], "write_ops_per_sec").size).toBe(0);
  });
});
