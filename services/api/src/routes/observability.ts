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

export function registerObservabilityRoutes(app: FastifyInstance, redis: RedisLike): void {
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
}
