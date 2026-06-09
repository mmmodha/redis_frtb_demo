// Wave 5.84C — profile lookup, dial resolution, refuse-or-go gate.

import { describe, it, expect } from "vitest";
import type { ClusterShape } from "../src/probe.ts";
import {
  pickProfile,
  profileDials,
  resolveDials,
  refuseOrGo,
  estimateDurationSec,
} from "../src/profile.ts";

function shape(mode: "standalone" | "cluster", shards: number, maxmemoryBytes = 0): ClusterShape {
  return { mode, shards, maxclients: 0, maxmemoryBytes, usedMemoryBytes: 0 };
}

describe("Wave 5.84C — pickProfile (auto-select from cluster shape)", () => {
  it("standalone → small", () => {
    expect(pickProfile(shape("standalone", 1))).toBe("small");
  });
  it("1-shard cluster → small", () => {
    expect(pickProfile(shape("cluster", 1))).toBe("small");
  });
  it("2-shard cluster → medium", () => {
    expect(pickProfile(shape("cluster", 2))).toBe("medium");
  });
  it("3-shard cluster → medium", () => {
    expect(pickProfile(shape("cluster", 3))).toBe("medium");
  });
  it("4-shard cluster → large", () => {
    expect(pickProfile(shape("cluster", 4))).toBe("large");
  });
  it("6-shard cluster → large", () => {
    expect(pickProfile(shape("cluster", 6))).toBe("large");
  });
});

describe("Wave 5.84C — profileDials (concrete dial values)", () => {
  it("small profile: workers=1 batch=500 window=1 streamShards=1", () => {
    expect(profileDials("small", shape("standalone", 1), 8)).toEqual({
      workers: 1, batchSize: 500, pipelineWindow: 1, streamShards: 1,
    });
  });
  it("medium profile: workers=2 batch=1500 window=2 streamShards=shards", () => {
    expect(profileDials("medium", shape("cluster", 3), 8)).toEqual({
      workers: 2, batchSize: 1500, pipelineWindow: 2, streamShards: 3,
    });
  });
  it("large profile: workers=min(shards, host_cores), batch=2000, window=2, streamShards=min(shards,32)", () => {
    expect(profileDials("large", shape("cluster", 6), 8).workers).toBe(6);
    expect(profileDials("large", shape("cluster", 6), 4).workers).toBe(4);
    expect(profileDials("large", shape("cluster", 12), 8).workers).toBe(8);
    expect(profileDials("large", shape("cluster", 6), 8).streamShards).toBe(6);
    expect(profileDials("large", shape("cluster", 64), 8).streamShards).toBe(32);
  });
  it("large profile: never returns workers < 1 even when hostCores=0", () => {
    expect(profileDials("large", shape("cluster", 4), 0).workers).toBe(1);
  });
});

describe("Wave 5.84C — resolveDials (manual overrides always win — DoD #4)", () => {
  const s = shape("cluster", 6);
  it("no overrides → profile dials passthrough", () => {
    const r = resolveDials("large", s, 8);
    expect(r).toMatchObject({ profile: "large", workers: 6, batchSize: 2000, pipelineWindow: 2, streamShards: 6 });
    expect(r.overrides).toEqual({ workers: false, batchSize: false, pipelineWindow: false, streamShards: false });
  });
  it("manual workers wins over profile", () => {
    const r = resolveDials("large", s, 8, { workers: 1 });
    expect(r.workers).toBe(1);
    expect(r.overrides.workers).toBe(true);
  });
  it("manual batchSize wins over profile", () => {
    const r = resolveDials("small", s, 8, { batchSize: 10_000 });
    expect(r.batchSize).toBe(10_000);
    expect(r.overrides.batchSize).toBe(true);
  });
  it("manual pipelineWindow wins over profile", () => {
    const r = resolveDials("medium", s, 8, { pipelineWindow: 8 });
    expect(r.pipelineWindow).toBe(8);
    expect(r.overrides.pipelineWindow).toBe(true);
  });
  it("manual streamShards wins over profile (Wave 5.92A)", () => {
    const r = resolveDials("small", s, 8, { streamShards: 8 });
    expect(r.streamShards).toBe(8);
    expect(r.overrides.streamShards).toBe(true);
  });
  it("all four overridden simultaneously", () => {
    const r = resolveDials("large", s, 8, { workers: 1, batchSize: 100, pipelineWindow: 1, streamShards: "per-bucket" });
    expect(r).toMatchObject({ workers: 1, batchSize: 100, pipelineWindow: 1, streamShards: "per-bucket" });
    expect(r.overrides).toEqual({ workers: true, batchSize: true, pipelineWindow: true, streamShards: true });
  });
});

describe("Wave 5.84C — refuseOrGo (memory-cap gate)", () => {
  it("no maxmemory cap → always allowed (probe skipped or no limit set)", () => {
    const r = refuseOrGo(shape("standalone", 1, 0), 1_000_000_000);
    expect(r.allowed).toBe(true);
    expect(r.maxmemoryBytes).toBe(0);
    expect(r.thresholdBytes).toBe(0);
  });
  it("450M rows × 2 KB > 50% of 4 GB → REFUSED (DoD #5)", () => {
    const r = refuseOrGo(shape("standalone", 1, 4 * 1024 * 1024 * 1024), 450_000_000);
    expect(r.allowed).toBe(false);
    expect(r.estimatedBytes).toBe(450_000_000 * 2048);
    expect(r.thresholdBytes).toBe(2 * 1024 * 1024 * 1024);
  });
  it("100k rows × 2 KB well under 50% of 4 GB → allowed", () => {
    const r = refuseOrGo(shape("standalone", 1, 4 * 1024 * 1024 * 1024), 100_000);
    expect(r.allowed).toBe(true);
  });
  it("exactly at threshold → allowed (≤, not <)", () => {
    const max = 1000;
    // bytesPerRow=10, rows=50 → 500 == max/2 → allowed
    const r = refuseOrGo(shape("standalone", 1, max), 50, 10);
    expect(r.estimatedBytes).toBe(500);
    expect(r.thresholdBytes).toBe(500);
    expect(r.allowed).toBe(true);
  });
  it("just over threshold → refused", () => {
    const r = refuseOrGo(shape("standalone", 1, 1000), 51, 10);
    expect(r.estimatedBytes).toBe(510);
    expect(r.allowed).toBe(false);
  });
});

describe("Wave 5.84C — estimateDurationSec (plan-block helper)", () => {
  it("scales inversely with workers", () => {
    const d1 = estimateDurationSec(1_000_000, 1);
    const d4 = estimateDurationSec(1_000_000, 4);
    expect(d4).toBeLessThan(d1);
    expect(d4).toBeCloseTo(d1 / 4, 5);
  });
  it("never returns Infinity for 0 workers (clamped to 1 internally)", () => {
    expect(Number.isFinite(estimateDurationSec(1000, 0))).toBe(true);
  });
});
