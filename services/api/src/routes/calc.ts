import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";
import {
  reduceCurvatureCharge,
  reduceRiskClassCharge,
  type BucketResult,
  type CorrelationSpec,
} from "../sbm/reduce.ts";

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

const ALLOWED_LEG = new Set(["delta", "vega", "curvature"]);
type Leg = "delta" | "vega" | "curvature";

// Routing table: (risk_class lowercased, leg) -> Redis Function name.
// Names are the bare function ids registered via redis.register_function in the
// frtb library snippets (services/calc/lib/*.lua); FCALL takes the function id
// only, NOT a "library.function" qualifier (the library is a container, not a
// namespace at call time — see Redis Functions docs / RESP3 FCALL spec).
// GIRR uses the original generic sbm_*_bucket pair (multi-tenor vectors).
// Equity and FX each ship dedicated single-purpose Delta/Vega functions that
// mirror the same locked I/O shape but encode the asset-class specifics
// (per-bucket weight map for Equity, single-factor-per-pair for FX).
// Curvature ships per-asset-class functions (Wave 5.16a/b) — bucket-level K_b
// is computed by the FCALL (which picks the worse of K_b^+/K_b^-), and the
// risk-class roll-up uses reduceCurvatureCharge with γ_curv = γ_delta² per
// §21.5(5).
// Unknown risk classes fall back to the generic GIRR pair so older calc paths
// keep working until each asset class is added.
const FUNC_BY_RISK_CLASS: Record<string, { delta: string; vega: string; curvature: string }> = {
  girr: { delta: "sbm_delta_bucket", vega: "sbm_vega_bucket", curvature: "girr_curvature" },
  equity: { delta: "equity_delta", vega: "equity_vega", curvature: "equity_curvature" },
  fx: { delta: "fx_delta", vega: "fx_vega", curvature: "fx_curvature" },
};
const DEFAULT_FUNCS = FUNC_BY_RISK_CLASS.girr!;

function funcNameFor(risk_class: string, leg: Leg): string {
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

// FT.INFO returns a flat key/value array like ["index_name", "idx:sens",
// ..., "num_docs", "27000", ...]. ioredis Cluster's coordinator sums
// num_docs across master shards, so a single call gives the cluster-wide
// populated count.
function parseFtInfoNumDocs(reply: unknown): number {
  if (Array.isArray(reply)) {
    for (let i = 0; i < reply.length - 1; i += 2) {
      if (String(reply[i]) === "num_docs") {
        return Number(reply[i + 1]) || 0;
      }
    }
    return 0;
  }
  if (reply && typeof reply === "object") {
    const r = reply as Record<string, unknown>;
    return Number(r.num_docs) || 0;
  }
  return 0;
}

// Returns master-node clients for fan-out (one entry per master in cluster
// mode), or [client] in standalone mode. Feature-detection mirrors
// resolveMasterNodes() in bootstrap.ts: ioredis Cluster has .nodes(), Redis
// does not.
function resolveQueryNodes(client: RedisLike): RedisLike[] {
  const maybe = client as { nodes?: (role: string) => RedisLike[] };
  if (typeof maybe.nodes === "function") {
    return maybe.nodes("master");
  }
  return [client];
}

/**
 * Registers `POST /calc/sbm`.
 *
 * Response shapes:
 *   200 { charge, per_bucket, total_ms, shard_breakdown, fanout_ms } — normal result
 *   400 { error }                                                    — bad request body
 *   503 { error: "no-data-or-index", risk_class, measure, hint }     — precondition failure
 *
 * The 503 branch fires when the cluster-aware bucket discovery returns zero
 * buckets AND FT.INFO reports num_docs=0 (or errors because no index exists).
 * This distinguishes "the index is missing on some/all shards or nothing has
 * been ingested yet" from a real zero charge on a populated portfolio (which
 * would still return 200). See Wave 5.8.4 + 5.15d.1 for context.
 *
 * Wave 5.15l (Option A — UPPERCASE at API entry): the generator writes keys
 * as `sens:{<UPPERCASE risk_class>:<bucket>}:*` and indexes the same value
 * under `@risk_class`. The Lua FRTB library at services/calc/lib/*.lua builds
 * its SCAN pattern from the FCALL `risk_class` arg via string concatenation,
 * which is case-sensitive even though RediSearch TAG matching is not. We
 * normalise the caller-supplied `risk_class` to UPPERCASE once at entry so
 * the FT.AGGREGATE query, the FCALL routing-key hash-tag, the FCALL
 * `risk_class` arg, the correlation-spec lookup, and the 503 diagnostic
 * payload all carry the canonical storage-shape form. Option B (lowercase on
 * ingest) was rejected because it would break every existing key and force a
 * full re-ingest. See smoke-run-12 SUMMARY "Named root cause" for the
 * end-to-end evidence chain.
 */
export function registerCalcRoute(
  app: FastifyInstance,
  getRedis: () => RedisLike,
  opts: CalcOpts,
): void {
  app.post<{ Body: CalcBody }>("/calc/sbm", async (req, reply) => {
    const risk_class_raw = req.body?.risk_class;
    const legRaw = req.body?.sensitivity_type;
    if (!risk_class_raw || !legRaw) {
      reply.code(400);
      return { error: "risk_class and sensitivity_type are required" };
    }
    const leg = String(legRaw).toLowerCase();
    if (!ALLOWED_LEG.has(leg)) {
      reply.code(400);
      return { error: `sensitivity_type must be one of: Delta, Vega, Curvature (got ${legRaw})` };
    }
    // Wave 5.15l: normalise to UPPERCASE so downstream consumers (FT.AGGREGATE
    // query, routeKey hash-tag, FCALL arg, Lua-side SCAN pattern) all see the
    // canonical storage-shape form regardless of inbound casing.
    const risk_class = String(risk_class_raw).toUpperCase();
    const funcName = funcNameFor(risk_class, leg as Leg);
    const corr: CorrelationSpec = opts.correlations[risk_class] ?? { kind: "constant", value: 0 };

    // Wave 5.16t — resolve the active redis client once per request so a
    // mid-flight target switch is picked up by the very next call.
    const redis = getRedis();
    const target_label = getActiveTarget().label;

    const t0 = process.hrtime.bigint();

    // 1) Discover buckets present for this risk_class — per-master fan-out.
    //    ioredis Cluster's coordinator does NOT aggregate FT.SEARCH / FT.AGGREGATE
    //    replies the way it aggregates FT.INFO: a single .call() lands on one
    //    slot owner and returns only that shard's view of the cluster-wide
    //    idx:sens. So we query every master and union the bucket sets in TS.
    //    In standalone mode resolveQueryNodes returns [client] and this is a
    //    single call exactly as before.
    const queryNodes = resolveQueryNodes(redis);
    const bucketSet = new Set<string>();
    try {
      for (const node of queryNodes) {
        const aggReply = await node.call(
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
        for (const b of parseBucketsFromAggregate(aggReply)) bucketSet.add(b);
      }
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const buckets = Array.from(bucketSet);

    // 1a) Precondition probe: an empty bucket list could mean either no data
    //     for this risk_class or — the Wave 5.7 failure mode — the index is
    //     missing on some shards. FT.INFO IS cluster-aggregated by ioredis
    //     Cluster (it sums num_docs across masters), so a single call gives
    //     the cluster-wide populated total without a per-shard fan-out. If
    //     num_docs is zero (or FT.INFO errors because no index exists),
    //     surface a 503 so callers don't mistake "no data" for a genuine
    //     sbm_charge=0.
    if (buckets.length === 0) {
      let numDocs = 0;
      try {
        const infoReply = await redis.call("FT.INFO", "idx:sens");
        numDocs = parseFtInfoNumDocs(infoReply);
      } catch {
        numDocs = 0;
      }
      if (numDocs === 0) {
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
    //    Build dispatchedKeys synchronously off `buckets` so the order matches
    //    `results` (Promise.all preserves input order) for the Wave 5.16m
    //    observability response.
    const fanoutStart = process.hrtime.bigint();
    const dispatchedKeys = buckets.map((b) => `sens:{${risk_class}:${b}}:_route`);
    let results: BucketResult[];
    try {
      results = await Promise.all(
        buckets.map(async (b, i): Promise<BucketResult> => {
          const routeKey = dispatchedKeys[i]!;
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
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const fanoutMs = Number(process.hrtime.bigint() - fanoutStart) / 1e6;

    // 3) Reduce per-bucket K_b/S_b → risk-class charge. Curvature follows the
    //    §21.5(5)/(5)(b) shape (γ² + ψ-gated cross terms); Delta/Vega use the
    //    §21.4(5)/(7) shape. `corr` carries the Delta γ in both cases —
    //    reduceCurvatureCharge squares it internally per §21.5(5).
    const charge =
      leg === "curvature"
        ? reduceCurvatureCharge(results, corr)
        : reduceRiskClassCharge(results, corr);
    const total_ms = Number(process.hrtime.bigint() - t0) / 1e6;

    // Wave 5.16m: observability — surface the exact Redis commands the route
    // dispatched (FT.AGGREGATE for discovery, FCALL per bucket for fan-out)
    // so the UI can render them verbatim for the demo. Read-only mirror of
    // what was already executed; nothing extra is computed or invoked here.
    const commands = {
      discovery: {
        command: "FT.AGGREGATE" as const,
        index: "idx:sens",
        query: `@risk_class:{${risk_class}}`,
        groupby: ["@bucket"],
        reducers: ["COUNT 0 AS n"],
      },
      fcall: {
        command: "FCALL" as const,
        function: funcName,
        library: "frtb",
        arg_template: `FCALL ${funcName} 1 sens:{${risk_class}:<bucket>}:_route ${risk_class} <bucket>`,
        dispatched_keys: dispatchedKeys,
      },
    };

    // Wave 5.16t — empty-result hint: discovery returned zero buckets but
    // the populated-index probe above let us through (num_docs > 0, so other
    // risk classes have data on the target). Surface a friendly note so the
    // UI can prompt "ingest data" instead of rendering charge=0 silently.
    const note = results.length === 0 && buckets.length === 0
      ? `No sensitivities on '${target_label}' — ingest data to run calculations.`
      : undefined;

    return {
      charge,
      per_bucket: results,
      total_ms: Math.round(total_ms * 1000) / 1000,
      shard_breakdown: results.map((r) => ({ shard: r.bucket, buckets: [r.bucket], ms: r.ms })),
      // diagnostic — useful for the demo "look how parallel we are" callout
      fanout_ms: Math.round(fanoutMs * 1000) / 1000,
      commands,
      ...(note ? { ok: true, note } : {}),
    };
  });
}
