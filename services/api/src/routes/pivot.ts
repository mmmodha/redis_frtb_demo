import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";

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
  limit?: string;
  offset?: string;
}

export function registerPivotRoute(app: FastifyInstance, redis: RedisLike): void {
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
    const query = parts.length === 0 ? "*" : parts.join(" ");

    const t0 = process.hrtime.bigint();
    const raw = (await redis.call(
      "FT.SEARCH",
      "idx:sens",
      query,
      "LIMIT",
      String(offset),
      String(limit),
      "DIALECT",
      "2"
    )) as unknown[];
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
