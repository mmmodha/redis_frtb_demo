import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";

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

export async function readShards(redis: RedisLike): Promise<Shard[]> {
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
}

export interface RegisterObservabilityOpts {
  sseIntervalMs?: number;
}

export function registerObservabilityRoutes(
  app: FastifyInstance,
  redis: RedisLike,
  opts: RegisterObservabilityOpts = {},
): void {
  const sseIntervalMs = opts.sseIntervalMs ?? 1000;
  app.get<{ Querystring: KeysQuery }>("/observability/keys", async (req) => {
    const prefix = req.query.prefix ?? "sens:";
    const t0 = process.hrtime.bigint();
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
  });

  app.get("/observability/memory", async () => {
    const t0 = process.hrtime.bigint();
    const text = await redis.info("memory");
    const parsed = parseInfo(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ...parsed, ms: Math.round(ms * 1000) / 1000 };
  });

  app.get("/observability/shards", async () => readShards(redis));

  // SSE: write one frame immediately, then every `sseIntervalMs` until the
  // client disconnects. We hijack the reply so Fastify doesn't try to send a
  // JSON body around it.
  app.get("/observability/shards/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
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
        const shards = await readShards(redis);
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
