import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";
import { corsHeadersForRequest } from "../cors-headers.ts";

const NUMERIC_INFO_FIELDS = new Set([
  "used_memory",
  "used_memory_peak",
  "used_memory_rss",
  "used_memory_dataset",
  "maxmemory",
  "mem_fragmentation_ratio",
  "total_system_memory",
  "total_net_input_bytes",
  "total_net_output_bytes",
  "instantaneous_ops_per_sec",
]);

function parseInfo(text: string): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx);
    const v = line.slice(idx + 1);
    if (NUMERIC_INFO_FIELDS.has(k)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface KeysQuery { prefix?: string }

export interface Shard {
  shardId: string;
  role: string;
  opsPerSec: number;
  slotCount: number;
  usedMemoryBytes: number;
  netInBytes: number;
  netOutBytes: number;
}

interface ParsedNode {
  id: string;
  role: "master" | "slave";
  slotCount: number;
}

// CLUSTER NODES line layout (per https://redis.io/commands/cluster-nodes/):
//   <id> <ip:port@cport[,hostname]> <flags> <master> <ping> <pong>
//   <epoch> <link-state> <slot> <slot> ...
// `flags` is comma-separated and may contain "myself", "master", "slave",
// "fail", etc. We treat anything tagged "master" (with or without "myself") as
// a primary; slaves are excluded from the shards list.
export function parseClusterNodes(text: string): ParsedNode[] {
  const out: ParsedNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const id = parts[0] ?? "";
    const flags = (parts[2] ?? "").split(",");
    const isMaster = flags.includes("master");
    const isSlave = flags.includes("slave");
    if (!isMaster && !isSlave) continue;
    let slotCount = 0;
    for (let i = 8; i < parts.length; i++) {
      const slot = parts[i] ?? "";
      if (!slot || slot.startsWith("[")) continue; // importing/migrating markers
      const dash = slot.indexOf("-");
      if (dash >= 0) {
        const lo = Number(slot.slice(0, dash));
        const hi = Number(slot.slice(dash + 1));
        if (Number.isFinite(lo) && Number.isFinite(hi)) slotCount += hi - lo + 1;
      } else {
        const n = Number(slot);
        if (Number.isFinite(n)) slotCount += 1;
      }
    }
    out.push({ id, role: isMaster ? "master" : "slave", slotCount });
  }
  return out;
}

// Wave 5.16i — Synthesise a single-element Shard[] for non-clustered targets
// (standalone Redis, Redis Cloud shared tiers, etc. where CLUSTER NODES is
// blocked with `ERR command is not allowed`). The UI's ObservabilityShard
// shape is the contract; slotCount=0 conveys "no slots" without claiming the
// full 16384.
async function buildStandaloneShards(redis: RedisLike): Promise<Shard[]> {
  const [memText, statsText] = await Promise.all([
    redis.info("memory"),
    redis.info("stats"),
  ]);
  const mem = parseInfo(memText);
  const stats = parseInfo(statsText);
  return [
    {
      shardId: "standalone",
      role: "master",
      opsPerSec: Number(stats.instantaneous_ops_per_sec ?? 0),
      slotCount: 0,
      usedMemoryBytes: Number(mem.used_memory ?? 0),
      netInBytes: Number(stats.total_net_input_bytes ?? 0),
      netOutBytes: Number(stats.total_net_output_bytes ?? 0),
    },
  ];
}

// Minimal logger surface — Fastify's `req.log` (pino) satisfies this; tests
// can pass a stub or nothing at all.
export interface ShardLogger {
  warn: (obj: Record<string, unknown>) => void;
}

export async function readShards(
  redis: RedisLike,
  log?: ShardLogger,
): Promise<Shard[]> {
  // Detect topology BEFORE calling CLUSTER NODES so standalone tiers (Redis
  // Cloud shared, etc.) don't surface as a 500. `INFO cluster` is permitted
  // on every tier. When `cluster_enabled` is missing from INFO we default to
  // the cluster path so the pre-5.16i contract is preserved verbatim for the
  // Wave 5.5 cluster-mode demos.
  let clusterEnabled: string | undefined;
  try {
    const text = await redis.info("cluster");
    const parsed = parseInfo(text);
    const ce = parsed.cluster_enabled;
    clusterEnabled = ce === undefined ? undefined : String(ce);
  } catch {
    clusterEnabled = undefined;
  }
  if (clusterEnabled === "0") {
    return buildStandaloneShards(redis);
  }

  try {
    const [nodesText, infoText] = await Promise.all([
      redis.call("CLUSTER", "NODES") as Promise<string>,
      redis.info(),
    ]);
    const parsed = parseClusterNodes(typeof nodesText === "string" ? nodesText : "");
    const info = parseInfo(infoText);
    const usedMemoryBytes = Number(info.used_memory ?? 0);
    const netInBytes = Number(info.total_net_input_bytes ?? 0);
    const netOutBytes = Number(info.total_net_output_bytes ?? 0);
    const opsPerSec = Number(info.instantaneous_ops_per_sec ?? 0);
    return parsed
      .filter((n) => n.role === "master")
      .map((n) => ({
        shardId: n.id.slice(0, 8),
        role: n.role,
        opsPerSec,
        slotCount: n.slotCount,
        usedMemoryBytes,
        netInBytes,
        netOutBytes,
      }));
  } catch (err) {
    // Defensive fallback: managed DBs that report `cluster_enabled:1` but
    // still block the CLUSTER command (some Redis Cloud configurations) hit
    // this branch. Case-insensitive substring match because the exact wording
    // ("ERR command is not allowed") may shift across versions.
    const reason = String(err);
    if (reason.toLowerCase().includes("not allowed")) {
      log?.warn?.({
        warn: "observability-shards-standalone-fallback",
        reason,
      });
      return buildStandaloneShards(redis);
    }
    throw err;
  }
}

export interface RegisterObservabilityOpts {
  sseIntervalMs?: number;
  // Wave 5.21i — resolved @fastify/cors allow-list value. Threaded in so the
  // hijacked /observability/shards/stream response carries the matching
  // access-control-allow-origin header (the cors plugin's onSend hook is
  // bypassed by reply.hijack()).
  corsAllowed?: true | string | string[];
}

export function registerObservabilityRoutes(
  app: FastifyInstance,
  getRedis: () => RedisLike,
  opts: RegisterObservabilityOpts = {},
): void {
  const sseIntervalMs = opts.sseIntervalMs ?? 1000;
  const corsAllowed = opts.corsAllowed ?? "http://localhost:3000";
  app.get<{ Querystring: KeysQuery }>("/observability/keys", async (req, reply) => {
    const prefix = req.query.prefix ?? "sens:";
    // Wave 5.16t — resolve active redis per-request so a profile switch is
    // picked up on the very next observability call.
    const redis = getRedis();
    const target_label = getActiveTarget().label;
    const t0 = process.hrtime.bigint();
    try {
      const [, keys] = await redis.scan("0", "MATCH", `${prefix}*`, "COUNT", "1000");
      const dbsize = await redis.dbsize();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return {
        prefix,
        dbsize,
        sample: keys.slice(0, 50),
        sample_size: Math.min(keys.length, 50),
        ms: Math.round(ms * 1000) / 1000,
      };
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  app.get("/observability/memory", async (_req, reply) => {
    const redis = getRedis();
    const target_label = getActiveTarget().label;
    const t0 = process.hrtime.bigint();
    try {
      const [text, dbsize] = await Promise.all([
        redis.info("memory"),
        redis.dbsize(),
      ]);
      const parsed = parseInfo(text);
      // Wave 5.20a — surface cluster capacity for the UI's pre-submit sanity
      // check. `maxmemory_bytes`/`total_system_memory_bytes` are the same
      // numeric values already parsed from INFO memory under their canonical
      // keys; the `_bytes` suffix mirrors the UI contract.
      const maxmemory_bytes = Number(parsed.maxmemory ?? 0);
      const total_system_memory_bytes = Number(parsed.total_system_memory ?? 0);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return {
        ...parsed,
        maxmemory_bytes,
        total_system_memory_bytes,
        dbsize,
        ms: Math.round(ms * 1000) / 1000,
      };
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  app.get("/observability/shards", async (req, reply) => {
    const redis = getRedis();
    const target_label = getActiveTarget().label;
    try {
      return await readShards(redis, req.log);
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  // SSE: write one frame immediately, then every `sseIntervalMs` until the
  // client disconnects. We hijack the reply so Fastify doesn't try to send a
  // JSON body around it.
  app.get("/observability/shards/stream", async (req, reply) => {
    const cors = corsHeadersForRequest(req, corsAllowed);
    reply.raw.writeHead(200, {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.hijack();
    let stopped = false;
    const send = async (): Promise<void> => {
      if (stopped) return;
      try {
        // Re-resolve per tick so an in-flight stream retargets on profile switch.
        const shards = await readShards(getRedis(), req.log);
        reply.raw.write(`data: ${JSON.stringify(shards)}\n\n`);
      } catch {
        // Swallow transient errors; the next tick may recover.
      }
    };
    await send();
    const interval = setInterval(send, sseIntervalMs);
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      try { reply.raw.end(); } catch { /* socket already closed */ }
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
