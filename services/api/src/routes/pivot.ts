import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { getSensIndexName } from "../lib/sens-index.ts";
import { translateRedisError } from "../redis-errors.ts";

// Escape RediSearch TAG punctuation per dialect 2 — colon, dash, brace, etc.
// are token separators and must be backslash-escaped to match literally.
const TAG_SPECIALS = /[\s,.<>{}\[\]"':;!@#$%^&*()\-+=~|\/?]/g;
function escapeTag(v: string): string {
  return v.replace(TAG_SPECIALS, (m) => `\\${m}`);
}

interface PivotQuery {
  risk_class?: string;
  bucket?: string;
  sensitivity_type?: string;
  book?: string;
  trade_id?: string;
  risk_factor?: string;
  limit?: string;
  offset?: string;
}

export function registerPivotRoute(
  app: FastifyInstance,
  getRedis: () => RedisLike,
): void {
  app.get<{ Querystring: PivotQuery }>("/pivot", async (req, reply) => {
    const q = req.query;
    const limit = Math.min(1000, Math.max(0, parseInt(q.limit ?? "100", 10) || 100));
    const offset = parseInt(q.offset ?? "0", 10);
    if (Number.isNaN(offset) || offset < 0) {
      reply.code(400);
      return { error: "offset must be a non-negative integer" };
    }

    const parts: string[] = [];
    if (q.risk_class) parts.push(`@risk_class:{${escapeTag(q.risk_class)}}`);
    if (q.bucket) parts.push(`@bucket:{${escapeTag(q.bucket)}}`);
    if (q.sensitivity_type) parts.push(`@sensitivity_type:{${escapeTag(q.sensitivity_type)}}`);
    if (q.book) parts.push(`@book:{${escapeTag(q.book)}}`);
    if (q.trade_id) parts.push(`@trade_id:{${escapeTag(q.trade_id)}}`);
    if (q.risk_factor) parts.push(`@risk_factor:{${escapeTag(q.risk_factor)}}`);
    const query = parts.length === 0 ? "*" : parts.join(" ");

    // Wave 5.16t — resolve active redis per-request so a profile switch is
    // picked up on the very next /pivot call.
    const redis = getRedis();
    const target_label = getActiveTarget().label;
    // Wave 6.18i — resolve to the live versioned `idx:sens:v{hash7}` so
    // FT.SEARCH targets the same index name bootstrap last created.
    const indexName = await getSensIndexName(redis, target_label);

    const t0 = process.hrtime.bigint();
    let raw: unknown[];
    try {
      raw = (await redis.call(
        "FT.SEARCH",
        indexName,
        query,
        "LIMIT",
        String(offset),
        String(limit),
        "DIALECT",
        "2"
      )) as unknown[];
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const total = Number(raw[0] ?? 0);
    const rows: Array<{ key: string; doc: unknown }> = [];
    // FT.SEARCH layout: [total, key1, fields1, key2, fields2, ...] where
    // fields1 is a flat ["$", "<json>"] array when RETURN $ is used (default).
    for (let i = 1; i < raw.length; i += 2) {
      const key = String(raw[i]);
      const fields = raw[i + 1] as unknown[] | undefined;
      let doc: unknown = null;
      if (Array.isArray(fields)) {
        // find $ in field pairs
        for (let j = 0; j < fields.length; j += 2) {
          if (fields[j] === "$" || fields[j] === "$.") {
            try {
              doc = JSON.parse(String(fields[j + 1]));
            } catch {
              doc = fields[j + 1];
            }
            break;
          }
        }
        if (doc === null) {
          // fall back to a flat field map if RETURN spec varies
          const m: Record<string, unknown> = {};
          for (let j = 0; j < fields.length; j += 2) m[String(fields[j])] = fields[j + 1];
          doc = m;
        }
      }
      rows.push({ key, doc });
    }

    return { rows, total, limit, offset, ms: Math.round(ms * 1000) / 1000 };
  });
}
