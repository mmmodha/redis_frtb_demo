// Wave 5.84C — parser tests for probe.ts. The parsers are pure, so we feed
// fixed CLUSTER INFO / INFO memory / CONFIG GET maxclients strings drawn
// from real Redis 7 builds (standalone, 2-shard, 6-shard) and assert the
// extracted ClusterShape fields. The probeCluster IO path is exercised at
// the CLI/integration layer.

import { describe, it, expect } from "vitest";
import {
  parseClusterInfo,
  parseInfoMemory,
  parseMaxclients,
  fallbackShape,
  BYTES_PER_ROW,
} from "../src/probe.ts";

const STANDALONE_CLUSTER_INFO = [
  "cluster_enabled:0",
  "cluster_state:ok",
  "cluster_slots_assigned:0",
  "cluster_slots_ok:0",
  "cluster_known_nodes:1",
  "cluster_size:0",
].join("\r\n");

const TWO_SHARD_CLUSTER_INFO = [
  "cluster_enabled:1",
  "cluster_state:ok",
  "cluster_slots_assigned:16384",
  "cluster_slots_ok:16384",
  "cluster_known_nodes:2",
  "cluster_size:2",
].join("\r\n");

const SIX_SHARD_CLUSTER_INFO = [
  "cluster_enabled:1",
  "cluster_state:ok",
  "cluster_slots_assigned:16384",
  "cluster_slots_ok:16384",
  "cluster_known_nodes:12",  // 6 masters + 6 replicas
  "cluster_size:6",
].join("\r\n");

const INFO_MEMORY_4GB = [
  "# Memory",
  "used_memory:1024000000",
  "used_memory_human:976.56M",
  "used_memory_rss:1100000000",
  "total_system_memory:17179869184",
  "maxmemory:4294967296",   // 4 GB
  "maxmemory_human:4.00G",
].join("\r\n");

const INFO_MEMORY_NO_CAP = [
  "# Memory",
  "used_memory:100000",
  "maxmemory:0",
].join("\r\n");

describe("Wave 5.84C — probe parsers", () => {
  describe("parseClusterInfo", () => {
    it("standalone Redis → enabled:false, size:0", () => {
      const r = parseClusterInfo(STANDALONE_CLUSTER_INFO);
      expect(r.enabled).toBe(false);
      expect(r.size).toBe(0);
      expect(r.state).toBe("ok");
    });
    it("2-shard cluster → enabled:true, size:2", () => {
      const r = parseClusterInfo(TWO_SHARD_CLUSTER_INFO);
      expect(r.enabled).toBe(true);
      expect(r.size).toBe(2);
    });
    it("6-shard cluster → enabled:true, size:6", () => {
      const r = parseClusterInfo(SIX_SHARD_CLUSTER_INFO);
      expect(r.enabled).toBe(true);
      expect(r.size).toBe(6);
    });
    it("tolerates missing keys (older Redis) → enabled:false, size:0", () => {
      const r = parseClusterInfo("# Cluster\r\n");
      expect(r.enabled).toBe(false);
      expect(r.size).toBe(0);
      expect(r.state).toBe("unknown");
    });
  });

  describe("parseInfoMemory", () => {
    it("4 GB maxmemory + ~1 GB used", () => {
      const m = parseInfoMemory(INFO_MEMORY_4GB);
      expect(m.maxmemory).toBe(4_294_967_296);
      expect(m.used_memory).toBe(1_024_000_000);
      expect(m.total_system_memory).toBe(17_179_869_184);
    });
    it("maxmemory:0 → 0 (no cap)", () => {
      const m = parseInfoMemory(INFO_MEMORY_NO_CAP);
      expect(m.maxmemory).toBe(0);
      expect(m.used_memory).toBe(100_000);
    });
    it("missing keys → zeros (no throw)", () => {
      const m = parseInfoMemory("# Memory\r\n");
      expect(m.maxmemory).toBe(0);
      expect(m.used_memory).toBe(0);
      expect(m.total_system_memory).toBe(0);
    });
  });

  describe("parseMaxclients", () => {
    it("ioredis-style array reply → number", () => {
      expect(parseMaxclients(["maxclients", "10000"])).toBe(10_000);
    });
    it("malformed reply → 0", () => {
      expect(parseMaxclients(null)).toBe(0);
      expect(parseMaxclients(["maxclients"])).toBe(0);
      expect(parseMaxclients(["maxclients", "not-a-number"])).toBe(0);
      expect(parseMaxclients(["maxclients", "0"])).toBe(0);
    });
  });

  describe("fallbackShape", () => {
    it("returns standalone, shards=1, maxmemory=0, fallback flag set", () => {
      const f = fallbackShape();
      expect(f.mode).toBe("standalone");
      expect(f.shards).toBe(1);
      expect(f.maxmemoryBytes).toBe(0);
      expect(f.maxclients).toBe(0);
      expect(f.fallback).toBe(true);
    });
  });

  describe("BYTES_PER_ROW constant", () => {
    it("is the documented 2 KB conservative estimate", () => {
      expect(BYTES_PER_ROW).toBe(2048);
    });
  });
});
