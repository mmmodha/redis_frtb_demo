import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";
import {
  CORRELATION_REGIME_FACTOR,
  reduceCurvatureCharge,
  reduceRiskClassCharge,
  scaleCorrelationSpec,
  type BucketResult,
  type CorrelationRegime,
  type CorrelationSpec,
} from "../sbm/reduce.ts";
import {
  aggregateBucketsViaIndex,
  buildFastPathAggregateArgs,
  buildFastPathQuery,
  FAST_PATH_ENGINE,
  formatRedisCommand,
  LUA_PATH_ENGINE,
  resolveLegFields,
} from "../sbm/aggregate-via-index.ts";
import {
  calcCacheKey,
  getDataVersion,
  lookupCalcCache,
  storeCalcCache,
} from "../sbm/calc-cache.ts";

// Wave 5.83C-1 — engine label stamped on every per-bucket result so the UI can
// render the badge (fast path vs. legacy Lua kernel). Mirrors the literals in
// sbm/aggregate-via-index.ts.
type EngineTag = typeof FAST_PATH_ENGINE | typeof LUA_PATH_ENGINE;
interface BucketResultWithEngine extends BucketResult {
  engine: EngineTag;
  // Wave 5.96A — per-bucket Redis command string surfaced to the drilldown UI.
  // Fast path: the FT.AGGREGATE the engine WOULD run for just this bucket
  // (single-bucket slice of the per-request FT.AGGREGATE). Lua path: the
  // FCALL with bucket / risk_class / exclude CSVs substituted in.
  resolved_command: string;
}

// Wave 5.83E — benchmark-only query parameters. Both are off by default so
// any caller that omits them gets byte-identical behaviour vs. pre-5.83E.
//   • nocache=1     → skip cache lookup AND skip cache store so each call
//                     forces a cold FT.AGGREGATE / FCALL fan-out.
//   • force_path=lua|fast → override the CALC_FAST_PATH env per request so a
//                     single api process can be benchmarked on both paths
//                     without a restart. Unknown values are ignored.
interface CalcQuery {
  nocache?: string;
  force_path?: string;
}

interface CalcBody {
  risk_class?: string;
  sensitivity_type?: string;
  // Wave 5.31a: optional discovery-layer narrowing. Restricts the FT.AGGREGATE
  // bucket-discovery to a caller-supplied subset so the second Calculate fans
  // out FCALL only over those buckets. Empty array or omitted = no narrowing.
  bucket_subset?: string[];
  // Wave 5.31b: Basel MAR21.6 cross-bucket γ regime selector. Omitted defaults
  // to "medium" (factor 1.0) which is a no-op vs. pre-5.31b behaviour.
  correlation_regime?: CorrelationRegime;
  // Wave 5.31c: optional kernel-side predicate push-down. Rows whose
  // book/trade_id/risk_factor match any of these sets are skipped inside the
  // per-bucket Lua kernel BEFORE contributing to K_b / S_b. Each list is
  // marshalled into a CSV positional FCALL arg (args 3/4/5). Omitted or empty
  // lists are byte-identical to the pre-5.31c kernel path.
  exclude?: { book?: string[]; trade_id?: string[]; risk_factor?: string[] };
}

const ALLOWED_REGIME = new Set<CorrelationRegime>(["low", "medium", "high"]);

// Wave 5.31a: TAG-token escape for the discovery query string. Duplicates the
// helper in routes/pivot.ts — kept inline rather than factored into a shared
// module because it's three lines and the extraction cost outweighs the reuse.
const TAG_SPECIALS = /[\s,.<>{}\[\]"':;!@#$%^&*()\-+=~|\/?]/g;
function escapeTag(v: string): string {
  return v.replace(TAG_SPECIALS, (m) => `\\${m}`);
}

// Wave 5.31a: cap the subset size so a pathological client can't blow up the
// FT.AGGREGATE query string. Matches the implicit cap of the existing
// "LIMIT 0 10000" — far more than any realistic bucket count per risk_class.
const MAX_BUCKET_SUBSET = 256;

// Wave 5.31c: per-list cap on the exclude predicate sets. Each list is
// marshalled into a CSV FCALL arg; this protects Lua memory on hostile input
// while sitting comfortably above any realistic demo case. Over the cap →
// 413 Payload Too Large per the locked design decision.
const MAX_EXCLUDE_LIST = 1000;
type ExcludeKey = "book" | "trade_id" | "risk_factor";
const EXCLUDE_KEYS: ExcludeKey[] = ["book", "trade_id", "risk_factor"];

interface CalcOpts {
  // Map of risk_class → cross-bucket correlation γ_bc spec. Loaded from
  // config/schema/frtb-default.yaml on server startup (server.ts), or passed
  // inline by unit tests.
  correlations: Record<string, CorrelationSpec>;
  // Wave 5.83C-1 — schema required by the FT.AGGREGATE fast path to resolve
  // per-class field names (per-tenor vs. scalar `ws_*`), intra-bucket ρ, and
  // the curvature ρ² closed-form. Optional so the existing test surface that
  // skips the schema can keep exercising the Lua kernel path via
  // CALC_FAST_PATH=0 (set in vitest.setup.ts).
  schema?: Schema;
}

// Wave 5.83C-1 — env toggle for the FT.AGGREGATE fast path. Default ON in
// production; vitest.setup.ts forces "0" so the legacy FCALL-stub tests keep
// passing. Read per request so an operator can flip it without restarting and
// individual fast-path tests can opt-in via beforeEach/afterEach.
function fastPathEnabled(schema: Schema | undefined): boolean {
  if (!schema) return false;
  return process.env.CALC_FAST_PATH !== "0";
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
  app.post<{ Body: CalcBody; Querystring: CalcQuery }>("/calc/sbm", async (req, reply) => {
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

    // Wave 5.31a: validate + normalise optional bucket_subset. Mirrors the
    // risk_class uppercase-at-entry policy so the discovery query carries the
    // canonical storage-shape form (GIRR currencies / FX pairs are stored
    // UPPERCASE; Equity numeric strings are case-insensitive). An empty array
    // is treated as "no subset" — same as omitting the field — to avoid the
    // easy-to-misuse "match nothing" footgun.
    const subsetRaw = req.body?.bucket_subset;
    let bucket_subset: string[] = [];
    if (subsetRaw !== undefined && subsetRaw !== null) {
      if (!Array.isArray(subsetRaw)) {
        reply.code(400);
        return { error: "bucket_subset must be an array of non-empty strings" };
      }
      for (const v of subsetRaw) {
        if (typeof v !== "string" || v.length === 0) {
          reply.code(400);
          return { error: "bucket_subset must be an array of non-empty strings" };
        }
      }
      if (subsetRaw.length > MAX_BUCKET_SUBSET) {
        reply.code(400);
        return { error: `bucket_subset exceeds maximum of ${MAX_BUCKET_SUBSET} entries` };
      }
      const seen = new Set<string>();
      for (const v of subsetRaw) {
        const u = v.toUpperCase();
        if (!seen.has(u)) seen.add(u);
      }
      bucket_subset = Array.from(seen);
    }

    // Wave 5.31b: validate optional correlation_regime (Basel MAR21.6). Default
    // "medium" → factor 1.0 → scaleCorrelationSpec returns the spec unchanged
    // → wire-shape regression is preserved vs. pre-5.31b.
    const regimeRaw = req.body?.correlation_regime;
    if (regimeRaw !== undefined && regimeRaw !== null) {
      if (typeof regimeRaw !== "string" || !ALLOWED_REGIME.has(regimeRaw as CorrelationRegime)) {
        reply.code(400);
        return { error: "correlation_regime must be one of: low, medium, high" };
      }
    }
    const regime: CorrelationRegime = (regimeRaw as CorrelationRegime | undefined) ?? "medium";

    // Wave 5.31c: validate + marshal the optional `exclude` predicate. Each
    // field is an array of non-empty strings without commas (the CSV
    // delimiter); over MAX_EXCLUDE_LIST entries → 413 per the design decision.
    // Missing/empty lists serialise to "" which the Lua kernel treats as
    // "no exclusion" — byte-identical to the pre-5.31c kernel path.
    const excludeRaw = req.body?.exclude;
    const excludeCsv: Record<ExcludeKey, string> = { book: "", trade_id: "", risk_factor: "" };
    if (excludeRaw !== undefined && excludeRaw !== null) {
      if (typeof excludeRaw !== "object" || Array.isArray(excludeRaw)) {
        reply.code(400);
        return { error: "exclude must be an object with optional book/trade_id/risk_factor arrays" };
      }
      for (const key of EXCLUDE_KEYS) {
        const list = (excludeRaw as Record<string, unknown>)[key];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list)) {
          reply.code(400);
          return { error: `exclude.${key} must be an array of non-empty strings` };
        }
        if (list.length > MAX_EXCLUDE_LIST) {
          reply.code(413);
          return { error: `exclude.${key} exceeds maximum of ${MAX_EXCLUDE_LIST} entries` };
        }
        const seen = new Set<string>();
        for (const v of list) {
          if (typeof v !== "string" || v.length === 0) {
            reply.code(400);
            return { error: `exclude.${key} must be an array of non-empty strings` };
          }
          if (v.includes(",")) {
            reply.code(400);
            return { error: `exclude.${key} values may not contain commas` };
          }
          seen.add(v);
        }
        excludeCsv[key] = Array.from(seen).join(",");
      }
    }
    const regimeFactor = CORRELATION_REGIME_FACTOR[regime];
    // CRITICAL — Curvature scaling order (§21.5(5) + §21.6): scale γ FIRST,
    // then square. Because reduceCurvatureCharge calls squareCorrelationSpec
    // on whatever we pass in, feeding it the scaled spec yields
    //   (γ × factor)²  =  γ² × factor²
    // which is the correct Basel interpretation. Scaling γ_curv directly
    // (i.e. γ² × factor) would be wrong by a factor of `factor`.
    const scaledCorr = scaleCorrelationSpec(corr, regimeFactor, 1.0);

    // Wave 5.16t — resolve the active redis client once per request so a
    // mid-flight target switch is picked up by the very next call.
    const redis = getRedis();
    const target_label = getActiveTarget().label;

    const t0 = process.hrtime.bigint();

    // Wave 5.83C-2 — short-TTL response cache lookup. Key combines the
    // normalised request body (post-validation, post-uppercase, post-dedup)
    // with a data-version stamp INCR'd on every /admin/flush. A hit returns
    // the cached body verbatim with cache:"hit" + cached_at_iso markers;
    // miss falls through to the FT.AGGREGATE + FCALL fan-out below.
    const cacheBody = {
      risk_class,
      sensitivity_type: leg,
      bucket_subset: [...bucket_subset].sort(),
      correlation_regime: regime,
      exclude: excludeCsv,
    };
    // Wave 5.83E — `?nocache=1` and `?force_path=lua|fast` are benchmark-only
    // query knobs. nocache=1 skips both lookup and store so every call forces
    // a cold fan-out. force_path participates in the cache key so the two
    // engines don't collide when the cache IS used.
    const noCache = req.query?.nocache === "1";
    const forcePathRaw = req.query?.force_path;
    const forcePath: "lua" | "fast" | null =
      forcePathRaw === "lua" || forcePathRaw === "fast" ? forcePathRaw : null;
    const dataVersion = await getDataVersion(redis);
    const cacheKey = calcCacheKey({ ...cacheBody, force_path: forcePath }, dataVersion);
    if (!noCache) {
      const hit = lookupCalcCache(cacheKey);
      if (hit) {
        return {
          ...(hit.value as Record<string, unknown>),
          cache: "hit" as const,
          cached_at_iso: hit.cachedAtIso,
        };
      }
    }

    // Wave 5.31a: build the discovery query string ONCE so the FT.AGGREGATE
    // call and the observability `commands.discovery.query` mirror agree by
    // construction. When a subset is supplied, push the @bucket TAG predicate
    // alongside @risk_class so the index returns only the requested slice.
    const discoveryQuery = bucket_subset.length > 0
      ? `@risk_class:{${risk_class}} @bucket:{${bucket_subset.map(escapeTag).join("|")}}`
      : `@risk_class:{${risk_class}}`;

    // 1) Discover buckets present for this risk_class — per-master fan-out.
    //    ioredis Cluster's coordinator does NOT aggregate FT.SEARCH / FT.AGGREGATE
    //    replies the way it aggregates FT.INFO: a single .call() lands on one
    //    slot owner and returns only that shard's view of the cluster-wide
    //    idx:sens. So we query every master and union the bucket sets in TS.
    //    In standalone mode resolveQueryNodes returns [client] and this is a
    //    single call exactly as before.
    const queryNodes = resolveQueryNodes(redis);
    const bucketSet = new Set<string>();
    // Wave 5.41: explicit TIMEOUT on the discovery FT.AGGREGATE so a slow
    // cluster surfaces as a captured error (and a 502 below) rather than
    // hanging the request behind the implicit module default. The `catch`
    // captures the error in `discoveryError` so the FT.AGGREGATE failure
    // isn't silently swallowed into a misleading charge=0 result.
    let discoveryError: string | null = null;
    try {
      for (const node of queryNodes) {
        const aggReply = await node.call(
          "FT.AGGREGATE",
          "idx:sens",
          discoveryQuery,
          "GROUPBY",
          "1",
          "@bucket",
          "LIMIT",
          "0",
          "10000",
          "DIALECT",
          "2",
          "TIMEOUT",
          "30000"
        );
        for (const b of parseBucketsFromAggregate(aggReply)) bucketSet.add(b);
      }
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      discoveryError = errMsg;
      app.log.warn({
        evt: "calc-discovery-failed",
        err: errMsg,
        query: discoveryQuery,
        risk_class,
        target_label,
      });
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
    //
    // Wave 5.41: numDocs is now lifted out of the empty-buckets branch so
    // the new 502 "discovery-failed" path below shares the same probe.
    let numDocs: number | null = null;
    if (buckets.length === 0 || discoveryError) {
      let probed = 0;
      try {
        const infoReply = await redis.call("FT.INFO", "idx:sens");
        probed = parseFtInfoNumDocs(infoReply);
      } catch {
        probed = 0;
      }
      numDocs = probed;
      if (buckets.length === 0 && numDocs === 0) {
        reply.code(503);
        return {
          error: "no-data-or-index",
          risk_class,
          measure: leg,
          hint: "ensure idx:sens exists on all masters and stream has been ingested",
        };
      }
    }

    // Wave 5.41: FT.AGGREGATE failed BUT idx:sens has data → surface the
    // upstream failure as 502 so the caller sees the underlying reason
    // instead of a misleading "No sensitivities" 200 with charge=0.
    if (discoveryError && numDocs !== null && numDocs > 0) {
      reply.code(502);
      return {
        error: "discovery-failed",
        reason: discoveryError,
        hint: "FT.AGGREGATE on idx:sens failed — see api warn log",
      };
    }

    // 2) Per-bucket K_b/S_b. Two execution paths share the same downstream
    //    reducer shape:
    //      • Wave 5.83C-1 fast path (default when opts.schema is present and
    //        CALC_FAST_PATH !== "0"): a single FT.AGGREGATE returns the per-
    //        bucket pre-weighted aggregates and TS computes K_b in-process via
    //        the constant-ρ closed form (Delta/Vega) or the §21.5(3) ψ-gated
    //        closed form (Curvature). Stamps engine="ft_aggregate" per bucket.
    //      • Legacy Lua path: one FCALL per bucket, runs slot-local on the
    //        owning shard because the routing key carries the
    //        {risk_class:bucket} hash-tag. Stamps engine="fcall_lua".
    //    `dispatchedKeys` is built off `buckets` regardless of path so the
    //    Wave 5.16m observability `commands.fcall.dispatched_keys` stays the
    //    same shape on both modes (the fast path didn't actually issue the
    //    FCALLs — the keys describe what the legacy path WOULD have dispatched
    //    for the same input).
    // Wave 5.83E — force_path overrides the CALC_FAST_PATH env at the request
    // level. Still requires opts.schema to be present (the fast path needs the
    // schema to resolve per-tenor weighted field names).
    const useFastPath = forcePath === "fast"
      ? opts.schema !== undefined
      : forcePath === "lua"
      ? false
      : fastPathEnabled(opts.schema);
    const fanoutStart = process.hrtime.bigint();
    const dispatchedKeys = buckets.map((b) => `sens:{${risk_class}:${b}}:_route`);
    let results: BucketResultWithEngine[];
    try {
      if (useFastPath) {
        const fast = await aggregateBucketsViaIndex({
          redis,
          schema: opts.schema!,
          riskClass: risk_class,
          leg: leg as Leg,
          filters: {
            bucketSubset: bucket_subset,
            exclude: {
              book: excludeCsv.book ? excludeCsv.book.split(",") : [],
              trade_id: excludeCsv.trade_id ? excludeCsv.trade_id.split(",") : [],
              risk_factor: excludeCsv.risk_factor ? excludeCsv.risk_factor.split(",") : [],
            },
          },
        });
        // Match the legacy bucket order (input `buckets` from discovery) so the
        // dispatched_keys[i]/results[i] correspondence holds. Missing fast-path
        // entries (e.g. a bucket the index sees in discovery but has zero rows
        // matching the sensitivity_type) collapse to zeroed BucketResults.
        const byBucket = new Map(fast.map((r) => [r.bucket, r]));
        // Wave 5.96A — per-bucket resolved_command renders the single-bucket
        // slice of the fast-path FT.AGGREGATE so the drilldown shows what the
        // engine WOULD dispatch for THIS bucket alone. We rebuild argv with a
        // bucketSubset of just [b] to preserve the per-class APPLY/REDUCE
        // pipeline verbatim (same alias scheme the live query uses).
        const legFields = resolveLegFields(opts.schema!, risk_class, leg as Leg);
        const perTenor = (opts.schema!.risk_classes[risk_class]?.tenor?.nodes?.length ?? 0) > 0
          && risk_class === "GIRR";
        const excludeFilter = {
          book: excludeCsv.book ? excludeCsv.book.split(",") : [],
          trade_id: excludeCsv.trade_id ? excludeCsv.trade_id.split(",") : [],
          risk_factor: excludeCsv.risk_factor ? excludeCsv.risk_factor.split(",") : [],
        };
        results = buckets.map((b) => {
          const r = byBucket.get(b) ?? {
            bucket: b, K_b: 0, S_b: 0, count: 0, ms: 0,
            intermediate: { path: "fast" as const, ws_squared_sum: 0, cross_term: 0 },
          };
          const perBucketQuery = buildFastPathQuery(risk_class, legFields.sensitivityType, {
            bucketSubset: [b],
            exclude: excludeFilter,
          });
          const perBucketArgv = buildFastPathAggregateArgs(perBucketQuery, legFields, perTenor);
          const resolved_command = formatRedisCommand("FT.AGGREGATE", perBucketArgv);
          return { ...r, engine: FAST_PATH_ENGINE, resolved_command };
        });
      } else {
        results = await Promise.all(
          buckets.map(async (b, i): Promise<BucketResultWithEngine> => {
            const routeKey = dispatchedKeys[i]!;
            // Wave 5.31c: positional args 3/4/5 are the exclude CSVs. Empty
            // strings are passed through unconditionally so the FCALL arity is
            // stable — the kernel's `_frtb_parse_csv_set` returns nil for "" and
            // takes the short-circuit "no exclusion" path.
            const r = (await redis.call(
              "FCALL",
              funcName,
              "1",
              routeKey,
              risk_class,
              b,
              excludeCsv.book,
              excludeCsv.trade_id,
              excludeCsv.risk_factor
            )) as unknown;
            const parsed = parseBucketReply(r) ?? { bucket: "", K_b: 0, S_b: 0, count: 0, ms: 0 };
            parsed.bucket = b;
            // Wave 5.96A — Lua path: intermediates are computed inside the
            // FCALL kernel and not surfaced (option B). Stamp `path: "lua"`
            // so the UI renders the "computed in Lua FCALL, intermediates not
            // surfaced" note instead of a broken formula block.
            const intermediate = { path: "lua" as const };
            const resolved_command = formatRedisCommand("FCALL", [
              funcName, "1", routeKey, risk_class, b,
              excludeCsv.book, excludeCsv.trade_id, excludeCsv.risk_factor,
            ]);
            return { ...parsed, engine: LUA_PATH_ENGINE, intermediate, resolved_command };
          })
        );
      }
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
    //    §21.4(5)/(7) shape. We pass `scaledCorr` — the §21.6 regime-scaled γ
    //    spec — into BOTH paths so the cross-bucket term reflects the chosen
    //    correlation regime. For Curvature, reduceCurvatureCharge squares the
    //    spec internally; feeding it the already-scaled γ yields (γ·f)² which
    //    is the correct interpretation (scale FIRST, then square).
    let charge: number;
    let curvatureBranch: "positive_interior" | "fallback_clipped_s" | undefined;
    if (leg === "curvature") {
      const out = reduceCurvatureCharge(results, scaledCorr);
      charge = out.charge;
      curvatureBranch = out.usedFallback ? "fallback_clipped_s" : "positive_interior";
    } else {
      charge = reduceRiskClassCharge(results, scaledCorr);
    }
    const total_ms = Number(process.hrtime.bigint() - t0) / 1e6;

    // Wave 5.16m / 5.31b: observability — surface the exact Redis commands the
    // route dispatched (FT.AGGREGATE for discovery, FCALL per bucket for
    // fan-out) plus the §21.6 regime applied to γ_bc so the UI can render the
    // full provenance verbatim for the demo. Read-only mirror; no extra work.
    const regimeNote =
      regime === "high"
        ? "γ × 1.25, each ρ_bc capped at 1.0"
        : regime === "low"
        ? "γ × 0.75"
        : "γ × 1.0 (no-op)";
    const commands = {
      discovery: {
        command: "FT.AGGREGATE" as const,
        index: "idx:sens",
        // Wave 5.31a: mirror the actual query string we just dispatched so the
        // observability panel reflects subset narrowing verbatim.
        query: discoveryQuery,
        groupby: ["@bucket"],
        reducers: ["COUNT 0 AS n"],
      },
      fcall: {
        command: "FCALL" as const,
        function: funcName,
        library: "frtb",
        // Wave 5.31c: arg_template surfaces the three exclude CSV positionals
        // so the UI commands panel makes the kernel-side predicate push-down
        // visible to demo audiences — the pushdown is invisible without it.
        arg_template: `FCALL ${funcName} 1 sens:{${risk_class}:<bucket>}:_route ${risk_class} <bucket> <exclude_book_csv> <exclude_trade_csv> <exclude_factor_csv>`,
        dispatched_keys: dispatchedKeys,
      },
      regime: {
        name: regime,
        factor: regimeFactor,
        cap: 1.0,
        note: regimeNote,
      },
    };

    // Wave 5.16t / 5.31a — empty-result hint. Two distinct empty cases land
    // here (the num_docs===0 case already 503'd above):
    //   • subset-driven empty: caller asked for buckets that don't exist for
    //     this risk_class → return a 200 with a subset-aware note rather than
    //     silently rendering charge=0.
    //   • no-subset empty: index is populated for other risk classes but this
    //     one has no rows → existing "ingest data" prompt.
    const note = results.length === 0 && buckets.length === 0
      ? bucket_subset.length > 0
        ? `No buckets in subset [${bucket_subset.join(",")}] have data for risk_class ${risk_class} on '${target_label}'.`
        : `No sensitivities on '${target_label}' — ingest data to run calculations.`
      : undefined;

    const body = {
      charge,
      per_bucket: results,
      total_ms: Math.round(total_ms * 1000) / 1000,
      shard_breakdown: results.map((r) => ({ shard: r.bucket, buckets: [r.bucket], ms: r.ms })),
      // diagnostic — useful for the demo "look how parallel we are" callout
      fanout_ms: Math.round(fanoutMs * 1000) / 1000,
      // Wave 5.31b: echo the regime that was actually applied so the UI badge
      // shows what was computed, not what the user thought they requested.
      correlation_regime: regime,
      // Wave 5.83C-1 — top-level engine field for the UI badge. All per-bucket
      // entries share the same engine within a single request, so a single
      // field is sufficient (and cheaper for the UI than scanning per_bucket).
      engine: useFastPath ? FAST_PATH_ENGINE : LUA_PATH_ENGINE,
      commands,
      ...(curvatureBranch !== undefined ? { curvature_branch: curvatureBranch } : {}),
      ...(note ? { ok: true, note } : {}),
    };
    // Wave 5.83C-2 — cache the successful response body so repeat requests
    // with the same canonicalised inputs short-circuit above. The cache:"miss"
    // marker on the wire mirrors the cache:"hit" marker added on lookup.
    // Wave 5.83E — `?nocache=1` skips store too so subsequent calls stay cold.
    if (!noCache) storeCalcCache(cacheKey, body);
    return { ...body, cache: "miss" as const };
  });
}
