// Wave 5.84C — cluster shape probe. Runs CLUSTER INFO, INFO memory and
// CONFIG GET maxclients against the target once at startup and returns a
// ClusterShape struct. The shape feeds profile.ts which picks safe dial
// defaults (workers / batch-size / pipeline-window) and the refuse-or-go
// memory-cap gate.
//
// Parsers are split out as pure functions so the test suite can exercise
// standalone / 2-shard / 6-shard topologies via fixed strings without
// spinning up a real cluster (DoD #8).
//
// BYTES_PER_ROW is the conservative per-row Stream-entry size used by the
// refuse-or-go gate. Empirically a serialized FRTB row (XADD field-value
// payload: risk_class + bucket + _hash_tag + _id + JSON payload with
// per-tenor risk_value) lands around 1.0–1.6 KB on disk; we round UP to
// 2 KB to leave headroom for stream metadata and avoid surprise OOMs.

import type { Redis, Cluster } from "ioredis";

export const BYTES_PER_ROW = 2048;

export interface ClusterShape {
  mode: "standalone" | "cluster";
  /** Number of master shards. 1 for standalone or single-shard cluster. */
  shards: number;
  /** Min per-node maxclients across master shards (0 if unknown). */
  maxclients: number;
  /** Aggregate maxmemory across master shards (bytes); 0 if no cap configured. */
  maxmemoryBytes: number;
  /** Aggregate used_memory across master shards (bytes). */
  usedMemoryBytes: number;
  /** True when the probe failed and we fell back to a conservative shape. */
  fallback?: boolean;
}

// Parse CLUSTER INFO output. cluster_enabled:0 → standalone; cluster_size
// is the number of masters with at least one slot. Tolerates missing keys
// (older Redis builds) by defaulting to standalone-with-1-shard.
export function parseClusterInfo(text: string): { enabled: boolean; size: number; state: string } {
  const get = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:(.*)$`, "m").exec(text);
    return m ? m[1]!.trim() : undefined;
  };
  const enabledRaw = get("cluster_enabled");
  const enabled = enabledRaw === "1";
  const sizeRaw = get("cluster_size");
  const size = sizeRaw !== undefined && Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : 0;
  const state = get("cluster_state") ?? "unknown";
  return { enabled, size, state };
}

// Parse INFO memory output. Same shape as the api's existing parseInfoMemory
// but lives here so the probe module is self-contained. Returns 0 for any
// missing key so callers can treat "unknown" as "no constraint".
export function parseInfoMemory(text: string): { used_memory: number; maxmemory: number; total_system_memory: number } {
  const get = (key: string): number => {
    const m = new RegExp(`^${key}:(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    used_memory: get("used_memory"),
    maxmemory: get("maxmemory"),
    total_system_memory: get("total_system_memory"),
  };
}

// Parse CONFIG GET maxclients reply. ioredis returns `["maxclients", "10000"]`
// (Array<string>). Returns 0 when the reply shape is unexpected so callers
// can treat the value as "unknown".
export function parseMaxclients(reply: unknown): number {
  if (Array.isArray(reply) && reply.length >= 2) {
    const n = Number(reply[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

// Conservative fallback used when the probe fails (DoD #7). One shard, no
// memory cap visible → the refuse-or-go gate skips and profile.ts picks
// `small`. Callers log a warning before returning this.
export function fallbackShape(): ClusterShape {
  return { mode: "standalone", shards: 1, maxclients: 0, maxmemoryBytes: 0, usedMemoryBytes: 0, fallback: true };
}

// Probe a single connected client. The return is bounded — we never throw;
// any failure inside surfaces as a fallback shape (the caller decides
// whether to log). Runs queries in parallel so the round-trip cost is one
// max(latency) instead of the sum.
export async function probeCluster(client: Redis | Cluster): Promise<ClusterShape> {
  try {
    const isCluster = isClusterClient(client);
    if (isCluster) {
      const cluster = client as Cluster;
      const nodes = cluster.nodes("master");
      if (nodes.length === 0) return fallbackShape();
      const perNode = await Promise.allSettled(nodes.map(async (n) => {
        const [clusterText, memText, maxc] = await Promise.all([
          n.cluster("INFO") as Promise<string>,
          n.info("memory") as Promise<string>,
          n.config("GET", "maxclients") as Promise<unknown>,
        ]);
        return { clusterText, memText, maxc };
      }));
      let maxclients = Infinity;
      let maxmemoryBytes = 0;
      let usedMemoryBytes = 0;
      let size = 0;
      for (const r of perNode) {
        if (r.status !== "fulfilled") continue;
        const mem = parseInfoMemory(r.value.memText);
        maxmemoryBytes += mem.maxmemory;
        usedMemoryBytes += mem.used_memory;
        const mc = parseMaxclients(r.value.maxc);
        if (mc > 0) maxclients = Math.min(maxclients, mc);
        if (size === 0) {
          const ci = parseClusterInfo(r.value.clusterText);
          size = ci.size;
        }
      }
      return {
        mode: "cluster",
        shards: Math.max(1, size || nodes.length),
        maxclients: Number.isFinite(maxclients) ? maxclients : 0,
        maxmemoryBytes,
        usedMemoryBytes,
      };
    }
    const redis = client as Redis;
    const [clusterText, memText, maxc] = await Promise.all([
      redis.cluster("INFO").catch(() => "") as Promise<string>,
      redis.info("memory") as Promise<string>,
      redis.config("GET", "maxclients") as Promise<unknown>,
    ]);
    const ci = parseClusterInfo(clusterText);
    const mem = parseInfoMemory(memText);
    const mc = parseMaxclients(maxc);
    return {
      mode: ci.enabled ? "cluster" : "standalone",
      shards: ci.enabled ? Math.max(1, ci.size) : 1,
      maxclients: mc,
      maxmemoryBytes: mem.maxmemory,
      usedMemoryBytes: mem.used_memory,
    };
  } catch {
    return fallbackShape();
  }
}

// ioredis exposes a Cluster constructor; we detect via duck-typing on
// `.nodes` so the probe doesn't import the Cluster class symbol (keeps the
// module tree-shake friendly for callers that only need the parsers).
function isClusterClient(client: Redis | Cluster): boolean {
  return typeof (client as { nodes?: unknown }).nodes === "function";
}
