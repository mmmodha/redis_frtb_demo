// Wave 7.0.9 — live bulk-loader replica discovery (no BULK_LOADER_REPLICAS env).

import { describe, it, expect } from "vitest";
import {
  probeBulkLoaderInstances,
  discoverBulkLoaderTopology,
  bulkLoaderFanOutAttempts,
  fetchAggregatedBulkLoadStatus,
  aggregateBulkLoadStatuses,
} from "../src/bulk-loader-topology.ts";

describe("probeBulkLoaderInstances", () => {
  it("dedupes by instance_id across parallel probes", async () => {
    const ids = ["r1:1", "r2:2", "r3:3"];
    let i = 0;
    const map = await probeBulkLoaderInstances(async () => {
      const instance_id = ids[i % ids.length]!;
      i += 1;
      return { instance_id, pool_size: 16, workers: [{ flushed: 1 }] };
    }, { maxProbes: 12 });
    expect(map.size).toBe(3);
    expect([...map.keys()].sort()).toEqual(["r1:1", "r2:2", "r3:3"]);
  });
});

describe("discoverBulkLoaderTopology", () => {
  it("reports live replica count and pool size", async () => {
    let n = 0;
    const topo = await discoverBulkLoaderTopology(async () => {
      n += 1;
      return {
        instance_id: `bulk-${n <= 2 ? 1 : 2}:1`,
        pool_size: 32,
        bound_target: { host: "10.0.0.1", port: 6379, label: "redis" },
        target_stale: false,
        target_watcher: "enabled",
        workers: [],
      };
    }, { maxProbes: 6 });
    expect(topo.live).toBe(true);
    expect(topo.replicas).toBe(2);
    expect(topo.pool_size_per_replica).toBe(32);
    expect(topo.bound_target).toEqual({ host: "10.0.0.1", port: 6379, label: "redis" });
  });

  it("returns live:false when all probes fail", async () => {
    const topo = await discoverBulkLoaderTopology(async () => {
      throw new Error("down");
    }, { maxProbes: 4 });
    expect(topo.live).toBe(false);
    expect(topo.replicas).toBe(1);
    expect(topo.instance_ids).toEqual([]);
  });
});

describe("bulkLoaderFanOutAttempts", () => {
  it("scales with discovered replica count", () => {
    expect(bulkLoaderFanOutAttempts(1)).toBe(4);
    expect(bulkLoaderFanOutAttempts(4)).toBe(8);
    expect(bulkLoaderFanOutAttempts(8)).toBe(16);
  });
});

describe("aggregateBulkLoadStatuses", () => {
  it("sums in_flight and flushed across replicas", () => {
    const agg = aggregateBulkLoadStatuses([
      {
        instance_id: "a:1",
        pool_size: 16,
        dispatcher: { in_flight: 100, high_water: 800 },
        workers: [{ flushed: 1000 }],
      },
      {
        instance_id: "b:2",
        pool_size: 16,
        dispatcher: { in_flight: 50, high_water: 800 },
        workers: [{ flushed: 2000 }],
      },
    ]);
    expect(agg.dispatcher?.in_flight).toBe(150);
    expect(agg.workers?.[0]?.flushed).toBe(3000);
    expect(agg.instance_id).toBe("aggregated:2");
  });
});

describe("fetchAggregatedBulkLoadStatus", () => {
  it("sums flushed once per distinct replica", async () => {
    const hosts = ["a:1", "b:2"];
    let i = 0;
    const snap = await fetchAggregatedBulkLoadStatus(async () => {
      const instance_id = hosts[i % hosts.length]!;
      i += 1;
      return { instance_id, pool_size: 16, workers: [{ flushed: 250 }] };
    }, 2);
    expect(snap.workers?.[0]?.flushed).toBe(500);
  });
});
