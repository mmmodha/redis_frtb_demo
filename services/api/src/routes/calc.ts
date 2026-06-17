import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import { seenBucketKey } from "@frtb/calc-shared/rollup-keys";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { getSensIndexName } from "../lib/sens-index.ts";
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
  ROLLUP_PATH_ENGINE,
  tryRollupReadout,
} from "../sbm/aggregate-via-index.ts";
import {
  calcCacheKey,
  getDataVersion,
  lookupCalcCache,
  storeCalcCache,
} from "../sbm/calc-cache.ts";
// Wave 6.01 — recent-runs ring buffer push happens at the tail of each
// successful /calc/sbm and /calc/sbm/total response so the Observability
// "Last Calculation" card can surface concrete telemetry without re-hitting
// the calculator UI. In-memory only; cleared on active-target switch.
import { listRecentRuns, pushRecentRun } from "../calc/recent-runs.ts";

// Wave 5.83C-1 — engine label stamped on every per-bucket result so the UI can
// render the badge (fast path vs. legacy Lua kernel). Mirrors the literals in
// sbm/aggregate-via-index.ts.
type EngineTag = typeof FAST_PATH_ENGINE | typeof LUA_PATH_ENGINE | typeof ROLLUP_PATH_ENGINE;
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

// Wave 5.96B — Total SBM orchestrator body. Shares the same bucket_subset +
// exclude shape as the per-cell /calc/sbm route so a caller that already
// filters one cell can lift the same payload onto /calc/sbm/total to filter
// across the entire 27-cell matrix.
interface TotalSbmBody {
  bucket_subset?: string[];
  exclude?: { book?: string[]; trade_id?: string[]; risk_factor?: string[] };
}

// Wave 5.96B — supported asset classes for the Total SBM orchestrator.
// Mirrors the keys of FUNC_BY_RISK_CLASS (UPPERCASE for parity with the
// canonical storage shape Wave 5.15l established). Unsupported classes are
// surfaced verbatim on the response so the UI can render them as greyed-out
// rows in the breakdown matrix.
const TOTAL_SBM_CLASSES: string[] = ["GIRR", "EQUITY", "FX"];
const TOTAL_SBM_UNSUPPORTED_CLASSES: string[] = [
  "csr_non_sec",
  "csr_sec_non_ctp",
  "csr_sec_ctp",
  "commodity",
];

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

// Wave 5.96B — minimal logger surface used by the compute helper (subset of
// FastifyBaseLogger). Lets the helper warn on discovery failures without
// pulling the full Fastify type into the function signature.
interface LogLike {
  warn: (obj: unknown, msg?: string) => void;
}

interface ComputeSbmInput {
  risk_class: string; // already UPPERCASE
  leg: Leg;
  bucket_subset: string[]; // already validated + deduped + uppercased
  regime: CorrelationRegime;
  excludeCsv: Record<ExcludeKey, string>;
  forcePath: "lua" | "fast" | null;
  noCache: boolean;
}

interface ComputeSbmCtx {
  redis: RedisLike;
  schema?: Schema;
  correlations: Record<string, CorrelationSpec>;
  log: LogLike;
}

type ComputeSbmOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; statusCode: number; body: Record<string, unknown> };

// Wave 5.96B — extracted core compute for a single (risk_class, leg, regime)
// triplet. Reuses the same discovery + fanout + reduce pipeline the /calc/sbm
// route has carried since Wave 5.7, so the new /calc/sbm/total orchestrator
// fans out without HTTP self-recursion and without duplicating Lua/fast-path
// branching logic.
async function computeSbmCharge(
  input: ComputeSbmInput,
  ctx: ComputeSbmCtx,
): Promise<ComputeSbmOutcome> {
  const { risk_class, leg, bucket_subset, regime, excludeCsv, forcePath, noCache } = input;
  const { redis, schema, correlations, log } = ctx;
  const funcName = funcNameFor(risk_class, leg);
  const corr: CorrelationSpec = correlations[risk_class] ?? { kind: "constant", value: 0 };
  const regimeFactor = CORRELATION_REGIME_FACTOR[regime];
  // CRITICAL — Curvature scaling order (§21.5(5) + §21.6): scale γ FIRST,
  // then square. Because reduceCurvatureCharge calls squareCorrelationSpec
  // on whatever we pass in, feeding it the scaled spec yields
  //   (γ × factor)²  =  γ² × factor²
  // which is the correct Basel interpretation.
  const scaledCorr = scaleCorrelationSpec(corr, regimeFactor, 1.0);
  const target_label = getActiveTarget().label;
  // Wave 6.18i — resolve the live versioned `idx:sens:v{hash7}` once per
  // request and reuse for discovery FT.AGGREGATE, the FT.INFO probe, the
  // fast-path aggregate fan-out, and the resolved-command echo. Cached 30s.
  const indexName = await getSensIndexName(redis, target_label);
  const t0 = process.hrtime.bigint();

  // Wave 5.83C-2 — short-TTL response cache lookup.
  const cacheBody = {
    risk_class,
    sensitivity_type: leg,
    bucket_subset: [...bucket_subset].sort(),
    correlation_regime: regime,
    exclude: excludeCsv,
  };
  const dataVersion = await getDataVersion(redis);
  const cacheKey = calcCacheKey({ ...cacheBody, force_path: forcePath }, dataVersion);
  if (!noCache) {
    const hit = lookupCalcCache(cacheKey);
    if (hit) {
      // Wave 5.96F — truthful cache-hit timing. The cached body carries the
      // cold-compute cost in `total_ms` / `fanout_ms`; replaying those would
      // make Redis caching look slow. Preserve them as `original_*` and
      // overwrite the headline timing fields with the freshly-measured hit
      // elapsed (lookup is in-process, expected <1 ms).
      const hitMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const cached = hit.value as Record<string, unknown>;
      const originalTotalMs = Number(cached.total_ms);
      const originalFanoutMs = Number(cached.fanout_ms);
      const body: Record<string, unknown> = {
        ...cached,
        total_ms: Math.round(hitMs * 1000) / 1000,
        fanout_ms: 0,
        cache: "hit" as const,
        cached_at_iso: hit.cachedAtIso,
      };
      if (Number.isFinite(originalTotalMs)) body.original_compute_ms = originalTotalMs;
      if (Number.isFinite(originalFanoutMs)) body.original_fanout_ms = originalFanoutMs;
      return { ok: true, body };
    }
  }

  // Wave 6.24 — bucket discovery is now a single SMEMBERS on
  // `seen:bucket:{<rc>}` instead of an FT.AGGREGATE-with-GROUPBY against
  // `idx:sens`. The set is maintained by ingest's apply path (see
  // services/ingest/src/consumer.ts:emitSeenSadds) and hash-tagged on
  // `<rc>` so it lives on the slot that owns the rollup hashes for this
  // risk class — a single command, no cluster fan-out. When the caller
  // narrows via `bucket_subset`, we intersect with the seen set so a typo
  // bucket name doesn't drive a downstream HGETALL miss.
  //
  // The "discoveryQuery" / FT.AGGREGATE shape is preserved as the
  // resolved-command echo for the UI's drilldown card (commands.discovery
  // below) — it's now purely informational, no longer executed.
  const discoveryQuery = bucket_subset.length > 0
    ? `@risk_class:{${risk_class}} @bucket:{${bucket_subset.map(escapeTag).join("|")}}`
    : `@risk_class:{${risk_class}}`;

  const bucketSet = new Set<string>();
  let discoveryError: string | null = null;
  try {
    const seenReply = await redis.call("SMEMBERS", seenBucketKey(risk_class));
    if (Array.isArray(seenReply)) {
      for (const b of seenReply) if (typeof b === "string") bucketSet.add(b);
    }
    if (bucket_subset.length > 0) {
      // Intersect: keep only subset entries that are actually populated.
      const subset = new Set(bucket_subset);
      for (const b of Array.from(bucketSet)) {
        if (!subset.has(b)) bucketSet.delete(b);
      }
    }
  } catch (err) {
    const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
    if (translated) {
      return { ok: false, statusCode: translated.status, body: translated.body };
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    discoveryError = errMsg;
    log.warn({
      evt: "calc-discovery-failed",
      err: errMsg,
      query: discoveryQuery,
      risk_class,
      target_label,
    });
  }
  const buckets = Array.from(bucketSet);

  // 1a) Precondition probe via FT.INFO num_docs.
  let numDocs: number | null = null;
  if (buckets.length === 0 || discoveryError) {
    let probed = 0;
    try {
      const infoReply = await redis.call("FT.INFO", indexName);
      probed = parseFtInfoNumDocs(infoReply);
    } catch {
      probed = 0;
    }
    numDocs = probed;
    if (buckets.length === 0 && numDocs === 0) {
      return {
        ok: false,
        statusCode: 503,
        body: {
          error: "no-data-or-index",
          risk_class,
          measure: leg,
          hint: "ensure idx:sens exists on all masters and stream has been ingested",
        },
      };
    }
  }

  if (discoveryError && numDocs !== null && numDocs > 0) {
    return {
      ok: false,
      statusCode: 502,
      body: {
        error: "discovery-failed",
        reason: discoveryError,
        hint: "FT.AGGREGATE on idx:sens failed — see api warn log",
      },
    };
  }

  // 2) Per-bucket K_b/S_b via fast path or Lua FCALL.
  const useFastPath = forcePath === "fast"
    ? schema !== undefined
    : forcePath === "lua"
    ? false
    : fastPathEnabled(schema);
  const fanoutStart = process.hrtime.bigint();
  const dispatchedKeys = buckets.map((b) => `sens:{${risk_class}:${b}}:_route`);
  let results: BucketResultWithEngine[];
  let engineUsed: EngineTag = useFastPath ? FAST_PATH_ENGINE : LUA_PATH_ENGINE;
  try {
    if (useFastPath) {
      // Wave 6.14b — fast-fast path. When ingest has been writing per-bucket
      // rollup hashes (Wave 6.14a), HGETALL them and skip FT.AGGREGATE
      // entirely. Disabled when CALC_ROLLUP_PATH=0 (bit-identical to today)
      // or when exclude predicates are set (rollups are pre-aggregated and
      // can't satisfy row-level filters). On any missing rollup the helper
      // returns null and we drop to the FT.AGGREGATE path below.
      const hasExclude = !!(excludeCsv.book || excludeCsv.trade_id || excludeCsv.risk_factor);
      const tryRollup = process.env.CALC_ROLLUP_PATH !== "0" && !hasExclude;
      const legFields = resolveLegFields(schema!, risk_class, leg);
      const perTenor = (schema!.risk_classes[risk_class]?.tenor?.nodes?.length ?? 0) > 0
        && risk_class === "GIRR";
      const excludeFilter = {
        book: excludeCsv.book ? excludeCsv.book.split(",") : [],
        trade_id: excludeCsv.trade_id ? excludeCsv.trade_id.split(",") : [],
        risk_factor: excludeCsv.risk_factor ? excludeCsv.risk_factor.split(",") : [],
      };
      const buildResolvedCommand = (b: string): string => {
        const perBucketQuery = buildFastPathQuery(risk_class, legFields.sensitivityType, {
          bucketSubset: [b],
          exclude: excludeFilter,
        });
        const perBucketArgv = buildFastPathAggregateArgs(perBucketQuery, legFields, perTenor, indexName);
        return formatRedisCommand("FT.AGGREGATE", perBucketArgv);
      };
      let rollup: BucketResult[] | null = null;
      if (tryRollup) {
        try {
          rollup = await tryRollupReadout(redis, schema!, risk_class, leg, buckets);
        } catch (err) {
          log.warn({
            evt: "calc-rollup-failed",
            err: err instanceof Error ? err.message : String(err),
            risk_class,
            leg,
          });
          rollup = null;
        }
      }
      if (rollup) {
        engineUsed = ROLLUP_PATH_ENGINE;
        const byBucketR = new Map(rollup.map((r) => [r.bucket, r]));
        results = buckets.map((b) => {
          const r = byBucketR.get(b) ?? {
            bucket: b, K_b: 0, S_b: 0, count: 0, ms: 0,
            intermediate: { path: "fast" as const, ws_squared_sum: 0, cross_term: 0 },
          };
          return { ...r, engine: ROLLUP_PATH_ENGINE, resolved_command: buildResolvedCommand(b) };
        });
      } else {
        const fast = await aggregateBucketsViaIndex({
          redis,
          schema: schema!,
          riskClass: risk_class,
          leg,
          filters: {
            bucketSubset: bucket_subset,
            exclude: excludeFilter,
          },
          components: { crossTopN: 10 },
          indexName,
        });
        const byBucket = new Map(fast.map((r) => [r.bucket, r]));
        results = buckets.map((b) => {
          const r = byBucket.get(b) ?? {
            bucket: b, K_b: 0, S_b: 0, count: 0, ms: 0,
            intermediate: { path: "fast" as const, ws_squared_sum: 0, cross_term: 0 },
          };
          return { ...r, engine: FAST_PATH_ENGINE, resolved_command: buildResolvedCommand(b) };
        });
      }
    } else {
      results = await Promise.all(
        buckets.map(async (b, i): Promise<BucketResultWithEngine> => {
          const routeKey = dispatchedKeys[i]!;
          const r = (await redis.call(
            "FCALL",
            funcName,
            "1",
            routeKey,
            risk_class,
            b,
            excludeCsv.book,
            excludeCsv.trade_id,
            excludeCsv.risk_factor,
          )) as unknown;
          const parsed = parseBucketReply(r) ?? { bucket: "", K_b: 0, S_b: 0, count: 0, ms: 0 };
          parsed.bucket = b;
          const intermediate = { path: "lua" as const };
          const resolved_command = formatRedisCommand("FCALL", [
            funcName, "1", routeKey, risk_class, b,
            excludeCsv.book, excludeCsv.trade_id, excludeCsv.risk_factor,
          ]);
          return { ...parsed, engine: LUA_PATH_ENGINE, intermediate, resolved_command };
        }),
      );
    }
  } catch (err) {
    const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
    if (translated) {
      return { ok: false, statusCode: translated.status, body: translated.body };
    }
    throw err;
  }
  const fanoutMs = Number(process.hrtime.bigint() - fanoutStart) / 1e6;

  // 3) Reduce per-bucket K_b/S_b → risk-class charge.
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

  const regimeNote =
    regime === "high"
      ? "γ × 1.25, each ρ_bc capped at 1.0"
      : regime === "low"
      ? "γ × 0.75"
      : "γ × 1.0 (no-op)";
  const commands = {
    discovery: {
      // Wave 6.24 — discovery is now SMEMBERS against the materialized
      // `seen:bucket:{<rc>}` set (maintained by ingest). The legacy
      // FT.AGGREGATE shape is preserved as the `legacy_query` echo so the
      // UI drilldown can still surface the equivalent index query for
      // operator copy-paste.
      command: "SMEMBERS" as const,
      key: seenBucketKey(risk_class),
      legacy_command: "FT.AGGREGATE" as const,
      legacy_index: indexName,
      legacy_query: discoveryQuery,
      groupby: ["@bucket"],
      reducers: ["COUNT 0 AS n"],
    },
    fcall: {
      command: "FCALL" as const,
      function: funcName,
      library: "frtb",
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

  const note = results.length === 0 && buckets.length === 0
    ? bucket_subset.length > 0
      ? `No buckets in subset [${bucket_subset.join(",")}] have data for risk_class ${risk_class} on '${target_label}'.`
      : `No sensitivities on '${target_label}' — ingest data to run calculations.`
    : undefined;

  // Wave 5.96G-api — distinguish "no rows scanned" from "real zero". A cell
  // reaches this branch only when the precondition probe found data somewhere
  // (numDocs > 0) OR buckets were discovered for this class. `data_status`
  // rides on per_bucket[].count — if every bucket scanned zero rows (or the
  // discovery returned an empty bucket set despite a populated index), the
  // UI renders "no data ingested" instead of $0.0000.
  const data_status: "populated" | "empty" =
    results.some((r) => Number(r.count) > 0) ? "populated" : "empty";

  const body: Record<string, unknown> = {
    charge,
    per_bucket: results,
    total_ms: Math.round(total_ms * 1000) / 1000,
    shard_breakdown: results.map((r) => ({ shard: r.bucket, buckets: [r.bucket], ms: r.ms })),
    fanout_ms: Math.round(fanoutMs * 1000) / 1000,
    correlation_regime: regime,
    engine: engineUsed,
    commands,
    data_status,
    ...(curvatureBranch !== undefined ? { curvature_branch: curvatureBranch } : {}),
    ...(note ? { ok: true, note } : {}),
  };
  if (!noCache) storeCalcCache(cacheKey, body);
  return { ok: true, body: { ...body, cache: "miss" as const } };
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
  // Wave 6.01 — read-only listing of the recent-runs ring buffer. Default
  // limit=5 covers the Observability card's expanded mini-table; max=20
  // matches the buffer capacity. Out-of-range / non-numeric inputs clamp
  // silently so a stray "?limit=foo" still returns a usable response.
  app.get<{ Querystring: { limit?: string } }>("/calc/recent", async (req) => {
    const raw = Number(req.query?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 20) : 5;
    return { items: listRecentRuns(limit) };
  });

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
    // Wave 5.96B — delegate to the shared compute helper so /calc/sbm/total
    // can fan out the same logic in-process across (class, leg, scenario)
    // cells without HTTP self-recursion.
    const outcome = await computeSbmCharge(
      {
        risk_class,
        leg: leg as Leg,
        bucket_subset,
        regime,
        excludeCsv,
        forcePath: req.query?.force_path === "lua" || req.query?.force_path === "fast"
          ? (req.query.force_path as "lua" | "fast")
          : null,
        noCache: req.query?.nocache === "1",
      },
      {
        redis: getRedis(),
        schema: opts.schema,
        correlations: opts.correlations,
        log: app.log,
      },
    );
    if (!outcome.ok) {
      reply.code(outcome.statusCode);
      return outcome.body;
    }
    // Wave 6.01 — record the served per-class response so the Observability
    // "Last Calculation" card can surface it. Push on cache hits too with
    // cache: "hit" so a warm cell still updates the card. Scenario only
    // rides along when the request explicitly set correlation_regime; the
    // default "medium" stays implicit.
    const b = outcome.body as {
      charge?: number;
      total_ms?: number;
      fanout_ms?: number;
      cache?: "hit" | "miss";
      engine?: string;
      per_bucket?: unknown[];
    };
    pushRecentRun({
      kind: "per_class",
      risk_class,
      leg,
      ...(regimeRaw !== undefined && regimeRaw !== null ? { scenario: regime } : {}),
      charge: Number(b.charge) || 0,
      total_ms: Number(b.total_ms) || 0,
      fanout_ms: Number(b.fanout_ms) || 0,
      cells_evaluated: Array.isArray(b.per_bucket) ? b.per_bucket.length : 0,
      cache: b.cache === "hit" ? "hit" : "miss",
      engine: typeof b.engine === "string" ? b.engine : "",
    });
    return outcome.body;
  });

  // Wave 5.96B — Total SBM orchestrator. Fans out computeSbmCharge over the
  // 27-cell (class × leg × scenario) matrix in parallel via Promise.all,
  // collapses per-scenario via Σ_class (Δ + V + Crv), then takes max over
  // low/medium/high to produce the final §21.4(8) risk charge. Surfaces a
  // breakdown matrix plus parallelism evidence (cumulative vs wall-clock ms)
  // so the UI can render the "Redis-fast" callout with concrete numbers.
  app.post<{ Body: TotalSbmBody; Querystring: CalcQuery }>(
    "/calc/sbm/total",
    async (req, reply) => {
      // Validation mirrors /calc/sbm so the orchestrator rejects the same
      // malformed payloads at entry. bucket_subset / exclude apply uniformly
      // to every cell — a single subset narrows discovery across the matrix.
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

      const forcePath: "lua" | "fast" | null =
        req.query?.force_path === "lua" || req.query?.force_path === "fast"
          ? (req.query.force_path as "lua" | "fast")
          : null;
      const noCache = req.query?.nocache === "1";

      const redis = getRedis();
      const ctx: ComputeSbmCtx = {
        redis,
        schema: opts.schema,
        correlations: opts.correlations,
        log: app.log,
      };

      // Wave 5.96B — orchestration matrix: only the three supported asset
      // classes ship Redis Functions today (csr_*/commodity are out of scope
      // per the locked spec). Legs and scenarios are the full §21.4(7)/(8)
      // crosses. Fanout is the cartesian product → 3·3·3 = 27 cells.
      const classes: string[] = TOTAL_SBM_CLASSES;
      const legs: Leg[] = ["delta", "vega", "curvature"];
      const scenarios: CorrelationRegime[] = ["low", "medium", "high"];

      const wallStart = process.hrtime.bigint();
      type CellPlan = { risk_class: string; leg: Leg; regime: CorrelationRegime };
      const plan: CellPlan[] = [];
      for (const rc of classes) for (const l of legs) for (const s of scenarios) {
        plan.push({ risk_class: rc, leg: l, regime: s });
      }

      // The proof-of-parallelism is here: Promise.all dispatches every cell
      // without awaiting between them so per-cell Redis round-trips overlap
      // on the cluster (or in-process fake) rather than serialising on the
      // event loop. The cumulative_ms / wall_clock_ms ratio reflects this.
      const cellPromises = plan.map(async (p) => {
        const cellStart = process.hrtime.bigint();
        const outcome = await computeSbmCharge(
          {
            risk_class: p.risk_class,
            leg: p.leg,
            bucket_subset,
            regime: p.regime,
            excludeCsv,
            forcePath,
            noCache,
          },
          ctx,
        );
        const cell_ms = Number(process.hrtime.bigint() - cellStart) / 1e6;
        return { plan: p, outcome, cell_ms };
      });
      const cells = await Promise.all(cellPromises);
      const wallClockMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

      // Surface a fatal infrastructure failure (cluster-loading / connection
      // refused) verbatim — those translate to 5xx in computeSbmCharge and
      // mean the whole request is unanswerable, not just one cell. A 503
      // "no-data-or-index" however is a legitimate per-cell skip (the class
      // simply has no sensitivities ingested) and contributes 0 to the
      // breakdown.
      for (const c of cells) {
        if (!c.outcome.ok) {
          const status = c.outcome.statusCode;
          const body = c.outcome.body as { error?: string };
          const isPerCellSkip = status === 503 && body.error === "no-data-or-index";
          if (!isPerCellSkip) {
            reply.code(status);
            return {
              ...body,
              risk_class: c.plan.risk_class,
              sensitivity_type: c.plan.leg,
              correlation_regime: c.plan.regime,
            };
          }
        }
      }

      // Wave 5.96B — collapse the 27-cell grid:
      //   breakdown[]               → one entry per (class, leg) with scenarios sub-map
      //   scenario_totals[scenario] → Σ_class (Δ + V + Crv) for that scenario
      //   total_sbm                 → max over scenarios
      //
      // Wave 5.96F — per-cell `ms` is the orchestrator's own `cell_ms`
      // measurement (fresh on every request, including cache hits), NOT the
      // inner `b.total_ms` (which on a cache hit replays the cold-compute
      // cost). The stale inner value is preserved as `original_compute_ms`
      // so cached cells can still show "this cell was a cache hit, original
      // cold cost was X s" tooltips. cumulative_ms / parallelism_factor are
      // derived from the fresh cell_ms so the wall-clock invariant
      // max(cell_ms) ≤ wall_clock_ms always holds.
      // Wave 5.96G-api — `data_status` rides next to `charge`/`ms` so the
      // UI can render "no data ingested" on cells whose buckets all scanned
      // zero rows (still 200, just an empty result), separate from the 503
      // "skipped" branch (whole class has no buckets at all).
      type CellDataStatus = "populated" | "empty" | "skipped";
      type CellInfo = {
        charge: number;
        ms: number;
        original_compute_ms?: number;
        cache?: "hit" | "miss";
        skipped: boolean;
        data_status: CellDataStatus;
      };
      const cellByKey = new Map<string, CellInfo>();
      let cumulative_ms = 0;
      let original_cumulative_ms = 0;
      let opsFired = 0;
      let cacheHits = 0;
      let cellsEmpty = 0;
      const opsSkippedSet = new Set<string>();
      for (const c of cells) {
        const key = `${c.plan.risk_class}|${c.plan.leg}|${c.plan.regime}`;
        const cellMsRounded = Math.round(c.cell_ms * 1000) / 1000;
        if (!c.outcome.ok) {
          cellByKey.set(key, {
            charge: 0,
            ms: cellMsRounded,
            skipped: true,
            data_status: "skipped",
          });
          opsSkippedSet.add(`${c.plan.risk_class}|${c.plan.leg}`);
        } else {
          const b = c.outcome.body as {
            charge?: number;
            total_ms?: number;
            original_compute_ms?: number;
            cache?: "hit" | "miss";
            data_status?: "populated" | "empty";
          };
          // On a cache hit the inner body's `total_ms` is already the fresh
          // hit elapsed (overwritten in computeSbmCharge) and the stored
          // cold-compute cost is in `original_compute_ms`. On a miss the
          // inner `total_ms` IS the cold-compute cost, so it doubles as the
          // "original" value (no separate field is present).
          const innerOriginal = Number(b.original_compute_ms);
          const innerTotal = Number(b.total_ms);
          const originalComputeMs = Number.isFinite(innerOriginal)
            ? innerOriginal
            : Number.isFinite(innerTotal) ? innerTotal : 0;
          const cellStatus: CellDataStatus = b.data_status === "empty" ? "empty" : "populated";
          const info: CellInfo = {
            charge: Number(b.charge) || 0,
            ms: cellMsRounded,
            original_compute_ms: Math.round(originalComputeMs * 1000) / 1000,
            cache: b.cache,
            skipped: false,
            data_status: cellStatus,
          };
          cellByKey.set(key, info);
          cumulative_ms += c.cell_ms;
          original_cumulative_ms += originalComputeMs;
          if (b.cache === "hit") cacheHits += 1;
          if (cellStatus === "empty") cellsEmpty += 1;
          opsFired += 1;
        }
      }

      const scenario_totals: Record<CorrelationRegime, number> = { low: 0, medium: 0, high: 0 };
      const breakdown = classes.flatMap((cls) =>
        legs.map((lg) => {
          const cellSkipped = scenarios.every(
            (s) => cellByKey.get(`${cls}|${lg}|${s}`)?.skipped !== false,
          );
          const scenarioBlock: Record<
            CorrelationRegime,
            {
              charge: number;
              ms: number;
              original_compute_ms?: number;
              data_status: CellDataStatus;
            }
          > = {
            low: { charge: 0, ms: 0, data_status: "skipped" },
            medium: { charge: 0, ms: 0, data_status: "skipped" },
            high: { charge: 0, ms: 0, data_status: "skipped" },
          };
          for (const s of scenarios) {
            const info = cellByKey.get(`${cls}|${lg}|${s}`)!;
            const cell: {
              charge: number;
              ms: number;
              original_compute_ms?: number;
              data_status: CellDataStatus;
            } = {
              charge: info.charge,
              ms: info.ms,
              data_status: info.data_status,
            };
            if (info.original_compute_ms !== undefined) {
              cell.original_compute_ms = info.original_compute_ms;
            }
            scenarioBlock[s] = cell;
            scenario_totals[s] += info.charge;
          }
          return {
            risk_class: cls,
            leg: lg,
            skipped: cellSkipped,
            scenarios: scenarioBlock,
          };
        }),
      );

      let winning_scenario: CorrelationRegime = "medium";
      let total_sbm = scenario_totals.medium;
      for (const s of scenarios) {
        if (scenario_totals[s] > total_sbm) {
          total_sbm = scenario_totals[s];
          winning_scenario = s;
        }
      }

      // Wave 5.96F — parallelism_factor is now (fresh cumulative cell_ms) /
      // wall_clock. Since each cell_ms ≤ wall_clock and at most `plan.length`
      // cells contribute, this lands in the realistic 1–N range (e.g. 5–30×
      // on real fan-outs), never the millions we saw when stale stored
      // total_ms values were summed.
      const parallelism_factor = wallClockMs > 0
        ? Math.round((cumulative_ms / wallClockMs) * 1000) / 1000
        : 0;
      // Wave 5.96N — companion to `parallelism_factor` that mirrors the
      // Σ-if-serial chip's data source. Sources the preserved cold
      // `original_cumulative_ms` so cache-hit runs surface the true
      // cold-vs-warm speedup (e.g. ×147,000) instead of the warm
      // cache-lookup parallelism (e.g. ×25). On cold runs the two are
      // identical because `original_cumulative_ms === cumulative_ms`.
      // Always emitted — kept in lockstep with `original_cumulative_ms`.
      const original_parallelism_factor = wallClockMs > 0
        ? Math.round((original_cumulative_ms / wallClockMs) * 1000) / 1000
        : 0;
      const ops_skipped = opsSkippedSet.size * scenarios.length;
      const orchestratorCache: "hit" | "miss" | "partial" | undefined =
        opsFired === 0 ? undefined
          : cacheHits === opsFired ? "hit"
          : cacheHits === 0 ? "miss"
          : "partial";

      const responseBody = {
        total_sbm,
        winning_scenario,
        scenario_totals: {
          low: Math.round(scenario_totals.low * 1e6) / 1e6,
          medium: Math.round(scenario_totals.medium * 1e6) / 1e6,
          high: Math.round(scenario_totals.high * 1e6) / 1e6,
        },
        breakdown,
        unsupported_classes: TOTAL_SBM_UNSUPPORTED_CLASSES,
        performance: {
          total_ms: Math.round(wallClockMs * 1000) / 1000,
          cumulative_ms: Math.round(cumulative_ms * 1000) / 1000,
          original_cumulative_ms: Math.round(original_cumulative_ms * 1000) / 1000,
          parallelism_factor,
          original_parallelism_factor,
          redis_ops_count: opsFired,
          ops_skipped,
          // Wave 5.96G-api — single banner trigger for the UI. Counts cells
          // where every bucket scanned zero rows (data_status === "empty").
          // Skipped (503) cells are NOT counted here — the existing
          // `ops_skipped` already covers that branch.
          cells_empty: cellsEmpty,
          ...(orchestratorCache ? { cache: orchestratorCache, cache_hits: cacheHits } : {}),
        },
        resolved_command_summary: `${plan.length} FT.AGGREGATE+FCALL fan-out via /calc/sbm (${classes.length} classes × ${legs.length} legs × ${scenarios.length} scenarios)`,
      };
      // Wave 6.01 — push the orchestrated total onto the recent-runs ring
      // buffer so the Observability "Last Calculation" card flips from the
      // per-class headline to "Total SBM" after a /calc/sbm/total run.
      // `cache: "hit"` only when every cell was a cache hit (orchestratorCache
      // === "hit"); partial / miss both record as "miss" — the precise count
      // lives in `cache_hits`.
      pushRecentRun({
        kind: "total",
        charge: total_sbm,
        total_ms: responseBody.performance.total_ms,
        cumulative_ms: responseBody.performance.cumulative_ms,
        parallelism_factor: responseBody.performance.parallelism_factor,
        redis_ops_count: opsFired,
        ops_skipped,
        cells_empty: cellsEmpty,
        cache_hits: cacheHits,
        cache: orchestratorCache === "hit" ? "hit" : "miss",
        engine: "orchestrator",
      });
      return responseBody;
    },
  );

  // Wave 5.96I — single-bucket K_b drilldown. Returns the same per-bucket
  // payload the parent /calc/sbm route surfaces inside per_bucket[i] (K_b,
  // S_b, count, ms, intermediate, engine, resolved_command) plus the cache /
  // timing envelope so the UI can refresh one bucket without re-running the
  // whole risk class. Delegates to computeSbmCharge with bucket_subset=[bucket]
  // so cache-key, fast/lua dispatch, regime scaling, and exclude predicates
  // are byte-identical to /calc/sbm. Curvature reuses the same code path —
  // the intermediate.curvature{k_plus, k_minus, winner, cvr_components} ride
  // along on the per_bucket[0] entry exactly as on the parent route.
  app.post<{
    Body: CalcBody & { bucket?: string; scenario?: string };
    Querystring: CalcQuery;
  }>(
    "/calc/sbm/bucket",
    async (req, reply) => {
      const risk_class_raw = req.body?.risk_class;
      const legRaw = req.body?.sensitivity_type;
      const bucketRaw = req.body?.bucket;
      if (!risk_class_raw || !legRaw || !bucketRaw) {
        reply.code(400);
        return { error: "risk_class, sensitivity_type and bucket are required" };
      }
      const leg = String(legRaw).toLowerCase();
      if (!ALLOWED_LEG.has(leg)) {
        reply.code(400);
        return { error: `sensitivity_type must be one of: Delta, Vega, Curvature (got ${legRaw})` };
      }
      if (typeof bucketRaw !== "string" || bucketRaw.length === 0) {
        reply.code(400);
        return { error: "bucket must be a non-empty string" };
      }
      const risk_class = String(risk_class_raw).toUpperCase();
      const bucket = bucketRaw.toUpperCase();

      // Scenario maps 1:1 onto the MAR21.6 correlation regime. Accept either
      // `scenario` (the drilldown UI's term) or `correlation_regime` (the
      // parent /calc/sbm payload key) so a caller can lift either shape.
      const scenarioRaw = req.body?.scenario ?? req.body?.correlation_regime;
      if (scenarioRaw !== undefined && scenarioRaw !== null) {
        if (
          typeof scenarioRaw !== "string"
          || !ALLOWED_REGIME.has(scenarioRaw as CorrelationRegime)
        ) {
          reply.code(400);
          return { error: "scenario must be one of: low, medium, high" };
        }
      }
      const regime: CorrelationRegime = (scenarioRaw as CorrelationRegime | undefined) ?? "medium";

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

      const forcePath: "lua" | "fast" | null =
        req.query?.force_path === "lua" || req.query?.force_path === "fast"
          ? (req.query.force_path as "lua" | "fast")
          : null;
      const noCache = req.query?.nocache === "1";

      const outcome = await computeSbmCharge(
        {
          risk_class,
          leg: leg as Leg,
          bucket_subset: [bucket],
          regime,
          excludeCsv,
          forcePath,
          noCache,
        },
        {
          redis: getRedis(),
          schema: opts.schema,
          correlations: opts.correlations,
          log: app.log,
        },
      );
      if (!outcome.ok) {
        reply.code(outcome.statusCode);
        return outcome.body;
      }
      const cellBody = outcome.body;
      const perBucket = Array.isArray(cellBody.per_bucket)
        ? (cellBody.per_bucket as BucketResultWithEngine[])
        : [];
      // Discovery narrowed by bucket_subset=[bucket] returns at most one
      // entry; pick the matching bucket and fall back to a zeroed stub when
      // the bucket carries no rows for this (risk_class, leg) so the empty
      // case stays a 200 with data_status="empty" instead of a 404.
      const match = perBucket.find((r) => r.bucket === bucket) ?? perBucket[0];
      const engineTag = (cellBody.engine as EngineTag | undefined)
        ?? (match?.engine ?? FAST_PATH_ENGINE);
      const result = match ?? {
        bucket,
        K_b: 0,
        S_b: 0,
        count: 0,
        ms: 0,
        engine: engineTag,
        resolved_command: "",
        intermediate: { path: engineTag === LUA_PATH_ENGINE ? ("lua" as const) : ("fast" as const) },
      };

      const body: Record<string, unknown> = {
        risk_class,
        sensitivity_type: leg,
        scenario: regime,
        bucket: result.bucket,
        K_b: result.K_b,
        S_b: result.S_b,
        count: result.count,
        ms: result.ms,
        intermediate: result.intermediate,
        engine: result.engine,
        resolved_command: result.resolved_command,
        data_status: cellBody.data_status,
        total_ms: cellBody.total_ms,
        fanout_ms: cellBody.fanout_ms,
        correlation_regime: cellBody.correlation_regime,
        commands: cellBody.commands,
        cache: cellBody.cache,
      };
      if (cellBody.cached_at_iso !== undefined) body.cached_at_iso = cellBody.cached_at_iso;
      if (cellBody.original_compute_ms !== undefined) {
        body.original_compute_ms = cellBody.original_compute_ms;
      }
      if (cellBody.original_fanout_ms !== undefined) {
        body.original_fanout_ms = cellBody.original_fanout_ms;
      }
      if (cellBody.curvature_branch !== undefined) {
        body.curvature_branch = cellBody.curvature_branch;
      }
      return body;
    },
  );

  // Wave 5.96A.1 — full per-bucket cross-component listing. The /calc/sbm
  // response carries the top-10 pairs by |contrib| on each bucket; this
  // endpoint reuses the same fast-path reducer for a SINGLE bucket with the
  // top-N cap removed so the UI's "Show all" toggle gets the complete list.
  // Mirrors /calc/sbm validation rules (uppercase risk_class, leg allow-list,
  // exclude predicates) and refuses non-fast-path requests since Lua kernels
  // don't surface component-level data (Wave 5.96A option B).
  app.post<{ Body: CalcBody & { bucket?: string } }>(
    "/calc/sbm/bucket-cross-detail",
    async (req, reply) => {
      const risk_class_raw = req.body?.risk_class;
      const legRaw = req.body?.sensitivity_type;
      const bucketRaw = req.body?.bucket;
      if (!risk_class_raw || !legRaw || !bucketRaw) {
        reply.code(400);
        return { error: "risk_class, sensitivity_type and bucket are required" };
      }
      const leg = String(legRaw).toLowerCase();
      if (!ALLOWED_LEG.has(leg)) {
        reply.code(400);
        return { error: `sensitivity_type must be one of: Delta, Vega, Curvature (got ${legRaw})` };
      }
      if (typeof bucketRaw !== "string" || bucketRaw.length === 0) {
        reply.code(400);
        return { error: "bucket must be a non-empty string" };
      }
      const risk_class = String(risk_class_raw).toUpperCase();
      const bucket = bucketRaw.toUpperCase();

      // Mirror /calc/sbm exclude validation so the per-bucket slice respects
      // the same kernel-side row-exclusion predicates.
      const excludeRaw = req.body?.exclude;
      const excludeArr: Record<ExcludeKey, string[]> = { book: [], trade_id: [], risk_factor: [] };
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
          excludeArr[key] = Array.from(seen);
        }
      }

      if (!opts.schema) {
        reply.code(503);
        return { error: "fast-path schema unavailable", hint: "bucket-cross-detail requires CALC_FAST_PATH" };
      }
      const redis = getRedis();
      const target_label = getActiveTarget().label;
      // Wave 6.18i — same versioned-index resolution as /calc/sbm so the
      // bucket-cross-detail endpoint targets the live `idx:sens:v{hash7}`.
      const indexName = await getSensIndexName(redis, target_label);
      try {
        const results = await aggregateBucketsViaIndex({
          redis,
          schema: opts.schema,
          riskClass: risk_class,
          leg: leg as Leg,
          filters: { bucketSubset: [bucket], exclude: excludeArr },
          components: { crossTopN: null },
          indexName,
        });
        const hit = results.find((r) => r.bucket === bucket);
        if (!hit) {
          return { bucket, cross_components: [] };
        }
        const cross = hit.intermediate?.cross_components ?? [];
        return { bucket, cross_components: cross };
      } catch (err) {
        const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
        if (translated) {
          reply.code(translated.status);
          return translated.body;
        }
        throw err;
      }
    },
  );
}
