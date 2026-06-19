import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";

// Wave 5.30a — autocomplete suggester backend.
//
// Wraps Redis Stack's purpose-built typeahead surface: FT.SUGGET against the
// three dictionaries `sug:book`, `sug:trade_id`, `sug:risk_factor` populated
// by the api bootstrap (one-shot backfill from idx:sens) and the ingest
// consumer (per-row INCR on every new sens:* doc). Independent of idx:sens —
// the suggester is a separate Redis Stack data structure tuned for prefix
// completion and does not require a RediSearch index to read.
//
// Cluster note: each suggester key lives on a single shard (the one its key
// name hashes to). FT.SUGGET on the ioredis Cluster client routes to that
// shard automatically — do NOT fan out reads across masters, you'd get
// inconsistent results depending on which shard you hit.

const ALLOWED_FIELDS = new Set(["book", "trade_id", "risk_factor"]);

interface SuggestQuery {
  field?: string;
  prefix?: string;
  fuzzy?: string;
  max?: string;
}

export interface RegisterSuggestOpts {
  // Wave 5.21i — resolved @fastify/cors allow-list value. Threaded in for
  // symmetry with the other route registrars; @fastify/cors is registered on
  // the app once in server.ts so this is informational at the moment.
  corsAllowed?: true | string | string[];
}

// FT.SUGGET WITHSCORES returns a flat array: [value, score, value, score, ...]
// (empty array → no matches). Score is returned as a string by ioredis (bulk
// reply); the route converts it to a number for the JSON response.
function parseSuggestReply(reply: unknown): Array<{ value: string; score: number }> {
  if (!Array.isArray(reply)) return [];
  const out: Array<{ value: string; score: number }> = [];
  for (let i = 0; i < reply.length; i += 2) {
    const value = String(reply[i]);
    const scoreRaw = reply[i + 1];
    const score = scoreRaw === undefined ? 0 : Number(scoreRaw);
    out.push({ value, score: Number.isFinite(score) ? score : 0 });
  }
  return out;
}

// FT.SUGGET on a missing key returns nil (Array.isArray(reply) === false) on
// modern Redis Stack builds — older builds raise an error. Both paths land in
// the 503 branch via the empty-array fall-through and the explicit catch.
function isMissingKeyError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return msg.includes("no such key") || msg.includes("nokey") || msg.includes("unknown key");
}

export function registerSuggestRoutes(
  app: FastifyInstance,
  getRedis: () => RedisLike,
  _opts: RegisterSuggestOpts = {},
): void {
  app.get<{ Querystring: SuggestQuery }>("/suggest", { config: { category: "heavy-calc" } }, async (req, reply) => {
    const field = req.query.field;
    const prefix = req.query.prefix;
    const fuzzyRaw = req.query.fuzzy ?? "1";
    const maxRaw = req.query.max ?? "10";

    if (!field || !ALLOWED_FIELDS.has(field)) {
      reply.code(400);
      return { error: `field must be one of: book, trade_id, risk_factor (got ${String(field)})` };
    }
    if (prefix === undefined || prefix === "") {
      reply.code(400);
      return { error: "prefix is required and must be non-empty" };
    }
    if (fuzzyRaw !== "0" && fuzzyRaw !== "1") {
      reply.code(400);
      return { error: "fuzzy must be 0 or 1" };
    }
    const max = parseInt(maxRaw, 10);
    if (!Number.isInteger(max) || max < 1 || max > 50) {
      reply.code(400);
      return { error: "max must be an integer in 1..50" };
    }

    const redis = getRedis();
    const target_label = getActiveTarget().label;
    const key = `sug:${field}`;
    const t0 = process.hrtime.bigint();

    // Build FT.SUGGET argv. FUZZY is positional (no value); WITHSCORES and
    // MAX <n> mirror the redis.io docs verbatim.
    const sugArgs: (string | number)[] = [key, prefix];
    if (fuzzyRaw === "1") sugArgs.push("FUZZY");
    sugArgs.push("WITHSCORES", "MAX", String(max));

    let raw: unknown;
    try {
      raw = await redis.call("FT.SUGGET", ...sugArgs);
    } catch (err) {
      if (isMissingKeyError(err)) {
        reply.code(503);
        return {
          error: "no-suggester-or-data",
          field,
          hint: "ensure bootstrap backfill ran or the ingest stream has produced rows",
        };
      }
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }

    const suggestions = parseSuggestReply(raw);
    if (suggestions.length === 0) {
      // Distinguish "prefix doesn't match anything in a populated dictionary"
      // from "dictionary is empty / missing". FT.SUGLEN is O(1) and only runs
      // on the no-result path so a normal hit doesn't pay the probe.
      let sugLen = 0;
      try {
        const lenReply = await redis.call("FT.SUGLEN", key);
        sugLen = Number(lenReply) || 0;
      } catch {
        sugLen = 0;
      }
      if (sugLen === 0) {
        reply.code(503);
        return {
          error: "no-suggester-or-data",
          field,
          hint: "ensure bootstrap backfill ran or the ingest stream has produced rows",
        };
      }
    }

    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { suggestions, ms: Math.round(ms * 1000) / 1000 };
  });
}
