import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { reduceRiskClassCharge, type BucketResult, type CorrelationSpec } from "../sbm/reduce.ts";

interface CalcBody {
  risk_class?: string;
  sensitivity_type?: string;
}

interface CalcOpts {
  // Map of risk_class → cross-bucket correlation γ_bc spec. Loaded from
  // config/schema/frtb-default.yaml on server startup (server.ts), or passed
  // inline by unit tests.
  correlations: Record<string, CorrelationSpec>;
}

const ALLOWED_LEG = new Set(["delta", "vega"]);

// Routing table: (risk_class lowercased, leg) -> Redis Function name.
// Names are the bare function ids registered via redis.register_function in the
// frtb library snippets (services/calc/lib/*.lua); FCALL takes the function id
// only, NOT a "library.function" qualifier (the library is a container, not a
// namespace at call time — see Redis Functions docs / RESP3 FCALL spec).
// GIRR uses the original generic sbm_*_bucket pair (multi-tenor vectors).
// Equity and FX each ship dedicated single-purpose Delta/Vega functions that
// mirror the same locked I/O shape but encode the asset-class specifics
// (per-bucket weight map for Equity, single-factor-per-pair for FX).
// Unknown risk classes fall back to the generic GIRR pair so older calc paths
// keep working until each asset class is added.
const FUNC_BY_RISK_CLASS: Record<string, { delta: string; vega: string }> = {
  girr: { delta: "sbm_delta_bucket", vega: "sbm_vega_bucket" },
  equity: { delta: "equity_delta", vega: "equity_vega" },
  fx: { delta: "fx_delta", vega: "fx_vega" },
};
const DEFAULT_FUNCS = FUNC_BY_RISK_CLASS.girr!;

function funcNameFor(risk_class: string, leg: "delta" | "vega"): string {
  const entry = FUNC_BY_RISK_CLASS[risk_class.toLowerCase()] ?? DEFAULT_FUNCS;
  return entry[leg];
}

// FCALL replies arrive in three shapes:
//   1. JSON string — the real `frtb` Lua library returns cjson.encode({...})
//      (RESP2 bulk-string). This is the production path.
//   2. Flat key/value array — RESP2 map fallback used by some test stubs.
//   3. Plain object — RESP3 map or in-process test stub.
// `Buffer` is also possible from ioredis if the connection is in binary mode;
// we coerce via String() before JSON.parse.
function parseBucketReply(reply: unknown): BucketResult | null {
  if (typeof reply === "string" || reply instanceof Buffer) {
    try {
      const parsed = JSON.parse(String(reply)) as Record<string, unknown>;
      return {
        bucket: "",
        K_b: Number(parsed.K_b),
        S_b: Number(parsed.S_b),
        count: Number(parsed.count),
        ms: Number(parsed.ms),
      };
    } catch {
      return null;
    }
  }
  if (Array.isArray(reply)) {
    const m: Record<string, string> = {};
    for (let i = 0; i < reply.length; i += 2) m[String(reply[i])] = String(reply[i + 1]);
    if (m.K_b === undefined) return null;
    return {
      bucket: "",
      K_b: Number(m.K_b),
      S_b: Number(m.S_b),
      count: Number(m.count),
      ms: Number(m.ms),
    };
  }
  if (reply && typeof reply === "object") {
    const r = reply as Record<string, unknown>;
    return {
      bucket: "",
      K_b: Number(r.K_b),
      S_b: Number(r.S_b),
      count: Number(r.count),
      ms: Number(r.ms),
    };
  }
  return null;
}

function parseBucketsFromAggregate(reply: unknown): string[] {
  if (!Array.isArray(reply)) return [];
  // [ total, [ "bucket", "USD-IRS" ], [ "bucket", "EUR-IRS" ], ... ]
  const buckets: string[] = [];
  for (let i = 1; i < reply.length; i++) {
    const row = reply[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j += 2) {
      const k = String(row[j]).replace(/^@/, "");
      if (k === "bucket") buckets.push(String(row[j + 1]));
    }
  }
  return buckets;
}

/**
 * Registers `POST /calc/sbm`.
 *
 * Response shapes:
 *   200 { charge, per_bucket, total_ms, shard_breakdown, fanout_ms } — normal result
 *   400 { error }                                                    — bad request body
 *   503 { error: "no-data-or-index", risk_class, measure, hint }     — precondition failure
 *
 * The 503 branch fires when FT.AGGREGATE discovers zero buckets AND a follow-up
 * FT.SEARCH probe finds zero matching rows for the requested risk_class. This
 * distinguishes "the index is missing on some/all shards or nothing has been
 * ingested yet" from a real zero charge on a populated portfolio (which would
 * still return 200). See Wave 5.8.4 for context.
 */
export function registerCalcRoute(app: FastifyInstance, redis: RedisLike, opts: CalcOpts): void {
  app.post<{ Body: CalcBody }>("/calc/sbm", async (req, reply) => {
    const risk_class = req.body?.risk_class;
    const legRaw = req.body?.sensitivity_type;
    if (!risk_class || !legRaw) {
      reply.code(400);
      return { error: "risk_class and sensitivity_type are required" };
    }
    const leg = String(legRaw).toLowerCase();
    if (!ALLOWED_LEG.has(leg)) {
      reply.code(400);
      return { error: `sensitivity_type must be one of: Delta, Vega (got ${legRaw})` };
    }
    const funcName = funcNameFor(risk_class, leg as "delta" | "vega");
    const corr: CorrelationSpec = opts.correlations[risk_class] ?? { kind: "constant", value: 0 };

    const t0 = process.hrtime.bigint();

    // 1) Discover buckets present for this risk_class — slot-fan-out friendly
    //    because @risk_class is a TAG filter and GROUPBY @bucket returns one
    //    row per bucket regardless of how rows are sharded.
    const aggReply = await redis.call(
      "FT.AGGREGATE",
      "idx:sens",
      `@risk_class:{${risk_class}}`,
      "GROUPBY",
      "1",
      "@bucket",
      "LIMIT",
      "0",
      "10000",
      "DIALECT",
      "2"
    );
    const buckets = parseBucketsFromAggregate(aggReply);

    // 1a) Precondition probe: an empty bucket list could mean either a real
    //     zero-data portfolio or — the Wave 5.7 failure mode — the index is
    //     missing on some shards. Issue a cheap FT.SEARCH ... LIMIT 0 0 to
    //     read the match count without paging documents. If the count is zero
    //     (or the search itself errors because no index exists), surface a 503
    //     with a diagnostic body so callers don't mistake "no data" for a
    //     genuine sbm_charge=0.
    if (buckets.length === 0) {
      let matchCount = 0;
      try {
        const searchReply = await redis.call(
          "FT.SEARCH",
          "idx:sens",
          `@risk_class:{${risk_class}}`,
          "LIMIT",
          "0",
          "0"
        );
        if (Array.isArray(searchReply) && searchReply.length > 0) {
          matchCount = Number(searchReply[0]) || 0;
        }
      } catch {
        matchCount = 0;
      }
      if (matchCount === 0) {
        reply.code(503);
        return {
          error: "no-data-or-index",
          risk_class,
          measure: leg,
          hint: "ensure idx:sens exists on all masters and stream has been ingested",
        };
      }
    }

    // 2) Fan out one FCALL per bucket — runs slot-local on the owning shard
    //    because the routing key carries the {risk_class:bucket} hash-tag.
    const fanoutStart = process.hrtime.bigint();
    const results = await Promise.all(
      buckets.map(async (b): Promise<BucketResult> => {
        const routeKey = `sens:{${risk_class}:${b}}:_route`;
        const r = (await redis.call(
          "FCALL",
          funcName,
          "1",
          routeKey,
          risk_class,
          b
        )) as unknown;
        const parsed = parseBucketReply(r) ?? { bucket: "", K_b: 0, S_b: 0, count: 0, ms: 0 };
        parsed.bucket = b;
        return parsed;
      })
    );
    const fanoutMs = Number(process.hrtime.bigint() - fanoutStart) / 1e6;

    // 3) Reduce per-bucket K_b/S_b → risk-class charge
    const charge = reduceRiskClassCharge(results, corr);
    const total_ms = Number(process.hrtime.bigint() - t0) / 1e6;

    return {
      charge,
      per_bucket: results,
      total_ms: Math.round(total_ms * 1000) / 1000,
      shard_breakdown: results.map((r) => ({ shard: r.bucket, buckets: [r.bucket], ms: r.ms })),
      // diagnostic — useful for the demo "look how parallel we are" callout
      fanout_ms: Math.round(fanoutMs * 1000) / 1000,
    };
  });
}
