import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, type Schema } from "@frtb/schema";
import { rollupKey } from "@frtb/calc-shared/rollup-keys";
import { regionFromDesk } from "@frtb/calc-shared/region";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget, onActiveTargetChange } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";
import { getSensIndexName } from "../lib/sens-index.ts";

// Wave 5.56 / 5.66 — facet counts backing the Search / Calc / JSON Explorer
// dropdowns. The UI uses these to hide classes/buckets/sens-types that report
// zero rows in the active index instead of presenting all hardcoded
// combinations.
//
// Wave 5.67 — Short-TTL (30 s) in-process cache keyed by active-target
// IDENTITY (host/port/db/tls/clusterMode). Label is excluded so renames don't
// invalidate the cache. `setActiveTarget` fires `onActiveTargetChange`, which
// clears the cache immediately.
//
// Wave 6.28 — uncached /facets latency was dominated by the per-tag FT.SEARCH
// server-side cost (~150ms × ~95 queries against 100M-row idx:sens, ~15s
// regardless of pipeline batching — 6.27's verifier confirmed the bottleneck
// was server-side serialization, not RTT). We now read the pre-aggregated
// counters maintained by ingest in `rollup:{rc:bkt}:<sens>` hashes (Wave
// 6.14a). Each rollup hash already has a `count` field (one HINCRBY per
// row), so the route just pipelines `HGET … count` for every (rc, bkt, sens)
// triple from the schema and sums in JS:
//   bucket_by_risk_class[rc][bk] = Σ_st count(rc,bk,st)
//   risk_class[rc]               = Σ_bk,st count(rc,bk,st)
//   sensitivity_type[st]         = Σ_rc,bk count(rc,bk,st)
//   total_rows                   = Σ_rc risk_class[rc]
// HGET against a 3-field hash is microseconds server-side, so uncached
// latency drops from ~15s to a single round trip + JS arithmetic. The
// FacetsResponseOk / FacetsResponseEmpty shape is unchanged.
//
// We pipeline the HGETs (rather than Promise.all) for the same RTT reason
// as 6.27 — the ioredis Cluster pipeline routes each command to the slot
// computed from the `{rc:bkt}` hash tag, so cross-shard fan-out happens
// inside one driver-level batch. A Promise.all fallback is retained for
// any RedisLike implementation without `.pipeline()` (currently none).

const CACHE_TTL_MS = 30_000;
const SENSITIVITY_TYPES = ["Delta", "Vega", "Curvature"] as const;

interface FacetsResponseOk {
  ok: true;
  ms: number;
  target_label: string;
  total_rows: number;
  risk_class: Record<string, number>;
  sensitivity_type: Record<string, number>;
  bucket_by_risk_class: Record<string, Record<string, number>>;
  cached: boolean;
}

interface FacetsResponseEmpty {
  ok: false;
  reason: "empty-index";
  ms: number;
  target_label: string;
  total_rows: 0;
  risk_class: Record<string, number>;
  sensitivity_type: Record<string, number>;
  bucket_by_risk_class: Record<string, Record<string, number>>;
  cached: boolean;
}

type FacetsBody = FacetsResponseOk | FacetsResponseEmpty;

function identityKey(): string {
  const t = getActiveTarget();
  return `${t.host}|${t.port}|${t.db ?? 0}|${t.tls ? 1 : 0}|${t.clusterMode ? 1 : 0}`;
}

let cache: { key: string; body: FacetsBody; expiresAt: number } | null = null;

// Wave 6.41.A — sibling caches for /facets/desk, /facets/region, and
// /facets/bucket. Same identity-keyed shape as `cache`, but with a 60s TTL
// (the per-route comments in registerFacetsRoute spell out why). Bodies are
// stored as `unknown` so each route can shape its own response without
// over-constraining the cache type.
const DESK_CACHE_TTL_MS = 60_000;
let deskCache: { key: string; body: unknown; expiresAt: number } | null = null;
let regionCache: { key: string; body: unknown; expiresAt: number } | null = null;
let bucketCache: { key: string; body: unknown; expiresAt: number } | null = null;

// Identity / creds rotation fires onActiveTargetChange (setActiveTargetLabel
// intentionally does NOT, so renames preserve the cache).
onActiveTargetChange(() => {
  cache = null;
  deskCache = null;
  regionCache = null;
  bucketCache = null;
});

export function __resetFacetsCacheForTests(): void {
  cache = null;
  deskCache = null;
  regionCache = null;
  bucketCache = null;
}

// Wave 5.86C — POST /admin/flush invokes this after FLUSHDB + bootstrap so the
// next /facets call sees the freshly-rebuilt index instead of the pre-flush
// body for up to CACHE_TTL_MS.
export function invalidateFacetsCache(): void {
  cache = null;
  deskCache = null;
  regionCache = null;
  bucketCache = null;
}

function emptyResponse(target_label: string, ms: number): FacetsResponseEmpty {
  return {
    ok: false,
    reason: "empty-index",
    ms,
    target_label,
    total_rows: 0,
    risk_class: {},
    sensitivity_type: {},
    bucket_by_risk_class: {},
    cached: false,
  };
}

function elapsedMs(t0: bigint): number {
  return Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
}

// HGET on a rollup hash returns RESP2 `string | null` — null when the field
// (or hash) is absent. Parse defensively to a finite non-negative integer.
function parseCountReply(reply: unknown): number {
  if (reply == null) return 0;
  const n = Number(reply);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Schema loader fallback — production wires `opts.schema` through from
// index.ts; tests pass schema via createServer. This lazy loader covers the
// edge case where neither happens (kept for defensive parity with the calc /
// generator routes that also accept an optional schema).
let lazySchemaCache: Schema | null = null;
function repoRootGuess(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}
function loadFacetsSchema(): Schema | null {
  if (lazySchemaCache) return lazySchemaCache;
  const path = process.env.SCHEMA_FILE
    ?? join(repoRootGuess(), "config/schema/frtb-default.yaml");
  if (!existsSync(path)) return null;
  lazySchemaCache = loadSchema(path);
  return lazySchemaCache;
}

// Structural type for the ioredis pipeline surface — both `Redis` and
// `Cluster` expose `.pipeline()` returning a chainable batcher whose
// `.exec()` resolves to the `[err, reply]` tuple array. Widened here rather
// than added to RedisLike so the narrow interface stays minimal (same
// pattern as PipelineClient in generator.ts).
type PipelineClient = {
  pipeline(): {
    call(command: string, ...args: unknown[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
};

function hasPipeline(r: RedisLike): r is RedisLike & PipelineClient {
  return typeof (r as unknown as Partial<PipelineClient>).pipeline === "function";
}

// Run the ordered list of `HGET <key> count` reads against the rollup hashes.
// When the client supports `.pipeline()` (production: ioredis Redis|Cluster)
// we pack them into a single non-transactional pipeline — `Cluster.pipeline`
// routes each command to the slot computed from the `{rc:bkt}` hash tag and
// fans out across shards inside one driver-level batch. The fallback path
// keeps a parallel Promise.all so minimal stubs without `.pipeline()` (none
// currently in tree) still work.
async function runRollupCountReads(
  redis: RedisLike,
  keys: string[],
): Promise<unknown[]> {
  if (hasPipeline(redis)) {
    const pipeline = redis.pipeline();
    for (const k of keys) {
      pipeline.call("HGET", k, "count");
    }
    const results = await pipeline.exec();
    if (!results) {
      // ioredis returns null when the pipeline is unexpectedly empty or
      // aborted before exec. Surface a recognisable error rather than
      // silently returning empty counts.
      throw new Error("HGET rollup pipeline returned null");
    }
    const replies: unknown[] = new Array(results.length);
    for (let i = 0; i < results.length; i++) {
      const tuple = results[i]!;
      const err = tuple[0];
      if (err) throw err;
      replies[i] = tuple[1];
    }
    return replies;
  }
  return Promise.all(keys.map((k) => redis.call("HGET", k, "count")));
}

export function registerFacetsRoute(
  app: FastifyInstance,
  // Wave 6.56.D4 — async accessor; routes await per-call.
  getRedis: () => RedisLike | Promise<RedisLike>,
  opts: { schema?: Schema } = {},
): void {
  app.get("/facets", { config: { category: "heavy-calc" } }, async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    const key = identityKey();
    const now = Date.now();
    if (cache && cache.key === key && cache.expiresAt > now) {
      const ms = elapsedMs(t0);
      return { ...cache.body, ms, cached: true };
    }

    const redis = await getRedis();
    const target_label = getActiveTarget().label;

    const schema = opts.schema ?? loadFacetsSchema();
    if (!schema) {
      // No schema available — degrade to the empty-index shape rather than
      // 500. Production always supplies a schema; this guards tests that
      // forget to pass one.
      const ms = elapsedMs(t0);
      const body = emptyResponse(target_label, ms);
      return body;
    }

    const riskClasses = Object.keys(schema.risk_classes);
    // Enumerate every (rc, bucket, sensitivity_type) triple the schema
    // permits. Each triple maps to a rollup hash key (Wave 6.14a) whose
    // `count` field holds the contributing-row count — ingest HINCRBYs
    // it once per ingested doc. The route reads them all in one
    // non-transactional pipeline and sums in JS.
    type Lookup = { rc: string; bk: string; st: string; key: string };
    const lookups: Lookup[] = [];
    for (const rc of riskClasses) {
      const cfg = schema.risk_classes[rc];
      const buckets = cfg?.buckets?.values ?? [];
      for (const bk of buckets) {
        for (const st of SENSITIVITY_TYPES) {
          lookups.push({ rc, bk, st, key: rollupKey(rc, bk, st) });
        }
      }
    }

    let replies: unknown[];
    try {
      replies = await runRollupCountReads(redis, lookups.map((l) => l.key));
    } catch (err) {
      // Transient / translatable errors must NOT be cached — a 412 during
      // bootstrap should not stick around for 30 s after the index comes up.
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }

    const ms = elapsedMs(t0);

    const risk_class: Record<string, number> = {};
    const sensitivity_type: Record<string, number> = {};
    const bucket_by_risk_class: Record<string, Record<string, number>> = {};

    // Aggregate per-triple counts into the three facet groupings:
    //   risk_class[rc]               = Σ_{bk,st} count(rc,bk,st)
    //   sensitivity_type[st]         = Σ_{rc,bk} count(rc,bk,st)
    //   bucket_by_risk_class[rc][bk] = Σ_{st}    count(rc,bk,st)
    // Missing / null HGET replies (e.g. (rc, bk, Curvature) with no data)
    // contribute 0 and are silently skipped.
    for (let i = 0; i < lookups.length; i++) {
      const n = parseCountReply(replies[i]);
      if (n <= 0) continue;
      const { rc, bk, st } = lookups[i]!;
      risk_class[rc] = (risk_class[rc] ?? 0) + n;
      sensitivity_type[st] = (sensitivity_type[st] ?? 0) + n;
      const inner = bucket_by_risk_class[rc] ?? (bucket_by_risk_class[rc] = {});
      inner[bk] = (inner[bk] ?? 0) + n;
    }

    // total_rows is the doc count (sum of per-class counts), NOT triple-
    // counted across the three facet groupings — matches existing semantics.
    const total_rows = Object.values(risk_class).reduce((a, b) => a + b, 0);

    if (total_rows === 0) {
      const body = emptyResponse(target_label, ms);
      cache = { key, body, expiresAt: Date.now() + CACHE_TTL_MS };
      return body;
    }

    const body: FacetsResponseOk = {
      ok: true,
      ms,
      target_label,
      total_rows,
      risk_class,
      sensitivity_type,
      bucket_by_risk_class,
      cached: false,
    };
    cache = { key, body, expiresAt: Date.now() + CACHE_TTL_MS };
    return body;
  });

  // Wave 6.41.A — three discovery endpoints for the calc / search filter
  // panes. All three are backed by FT.AGGREGATE GROUPBY against `idx:sens`
  // (no ingest writer changes — desk discovery follows the @desk TAG that
  // ingest already writes) and share the same 60s in-process cache keyed
  // by active-target identity. server.ts is on the 6.36 surface lock so we
  // wire these next to /facets rather than as separate top-level files.

  // GET /facets/desk — `FT.AGGREGATE idx:sens "*" GROUPBY 1 @desk REDUCE
  // COUNT 0 AS count SORTBY 2 @count DESC LIMIT 0 100`.
  app.get("/facets/desk", { config: { category: "heavy-calc" } }, async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    const key = identityKey();
    const now = Date.now();
    if (deskCache && deskCache.key === key && deskCache.expiresAt > now) {
      const ms = elapsedMs(t0);
      return { ...(deskCache.body as Record<string, unknown>), ms, cached: true };
    }
    const redis = await getRedis();
    const target_label = getActiveTarget().label;
    const indexName = await getSensIndexName(redis, target_label);
    let reply2: unknown;
    try {
      reply2 = await redis.call(
        "FT.AGGREGATE", indexName, "*",
        "GROUPBY", "1", "@desk",
        "REDUCE", "COUNT", "0", "AS", "count",
        "SORTBY", "2", "@count", "DESC",
        "LIMIT", "0", "100",
      );
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const desks = parseDeskCountRows(reply2);
    const ms = elapsedMs(t0);
    const body = { ok: true as const, ms, target_label, desks, cached: false };
    deskCache = { key, body, expiresAt: Date.now() + DESK_CACHE_TTL_MS };
    return body;
  });

  // GET /facets/region — derived from @desk in JS. Identical FT.AGGREGATE
  // GROUPBY @desk as /facets/desk, then collapses desks into their region
  // segment ([CLASS]_[REGION] → REGION) via shared/calc/src/region.ts so
  // the kernel + facets share one parser. Empty / malformed desks land in
  // the "UNKNOWN" bucket.
  app.get("/facets/region", { config: { category: "heavy-calc" } }, async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    const key = identityKey();
    const now = Date.now();
    if (regionCache && regionCache.key === key && regionCache.expiresAt > now) {
      const ms = elapsedMs(t0);
      return { ...(regionCache.body as Record<string, unknown>), ms, cached: true };
    }
    const redis = await getRedis();
    const target_label = getActiveTarget().label;
    const indexName = await getSensIndexName(redis, target_label);
    let reply2: unknown;
    try {
      reply2 = await redis.call(
        "FT.AGGREGATE", indexName, "*",
        "GROUPBY", "1", "@desk",
        "REDUCE", "COUNT", "0", "AS", "count",
        "LIMIT", "0", "1000",
      );
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const desks = parseDeskCountRows(reply2);
    const byRegion: Record<string, number> = {};
    for (const d of desks) {
      const r = regionFromDesk(d.desk);
      byRegion[r] = (byRegion[r] ?? 0) + d.count;
    }
    const regions = Object.entries(byRegion)
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count || (a.region < b.region ? -1 : 1));
    const ms = elapsedMs(t0);
    const body = { ok: true as const, ms, target_label, regions, cached: false };
    regionCache = { key, body, expiresAt: Date.now() + DESK_CACHE_TTL_MS };
    return body;
  });

  // GET /facets/bucket — `FT.AGGREGATE idx:sens "*" GROUPBY 2 @risk_class
  // @bucket REDUCE COUNT 0 AS count SORTBY 4 @risk_class ASC @bucket ASC
  // LIMIT 0 500`. Returns (risk_class, bucket, count) triples so the UI can
  // group buckets by risk_class for the calc filter pane.
  app.get("/facets/bucket", { config: { category: "heavy-calc" } }, async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    const key = identityKey();
    const now = Date.now();
    if (bucketCache && bucketCache.key === key && bucketCache.expiresAt > now) {
      const ms = elapsedMs(t0);
      return { ...(bucketCache.body as Record<string, unknown>), ms, cached: true };
    }
    const redis = await getRedis();
    const target_label = getActiveTarget().label;
    const indexName = await getSensIndexName(redis, target_label);
    let reply2: unknown;
    try {
      reply2 = await redis.call(
        "FT.AGGREGATE", indexName, "*",
        "GROUPBY", "2", "@risk_class", "@bucket",
        "REDUCE", "COUNT", "0", "AS", "count",
        "SORTBY", "4", "@risk_class", "ASC", "@bucket", "ASC",
        "LIMIT", "0", "500",
      );
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const buckets = parseRiskClassBucketRows(reply2);
    const ms = elapsedMs(t0);
    const body = { ok: true as const, ms, target_label, buckets, cached: false };
    bucketCache = { key, body, expiresAt: Date.now() + DESK_CACHE_TTL_MS };
    return body;
  });
}

// Wave 6.41.A — FT.AGGREGATE row parsers shared across the three new
// endpoints. RESP2 returns `[ total, [ "@field", "value", ... ], ... ]`;
// RESP3 / in-process fakes can return map-shaped rows. Both branches drop
// the leading `@` from field names.
function parseDeskCountRows(reply: unknown): Array<{ desk: string; count: number }> {
  const out: Array<{ desk: string; count: number }> = [];
  if (!Array.isArray(reply)) return out;
  for (let i = 1; i < reply.length; i++) {
    const row = reply[i];
    const m: Record<string, string> = {};
    if (Array.isArray(row)) {
      for (let j = 0; j < row.length; j += 2) {
        m[String(row[j]).replace(/^@/, "")] = String(row[j + 1]);
      }
    } else if (row && typeof row === "object") {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        m[k.replace(/^@/, "")] = String(v);
      }
    }
    if (m.desk) {
      const n = Number(m.count ?? 0);
      out.push({ desk: m.desk, count: Number.isFinite(n) ? n : 0 });
    }
  }
  return out;
}

function parseRiskClassBucketRows(
  reply: unknown,
): Array<{ risk_class: string; bucket: string; count: number }> {
  const out: Array<{ risk_class: string; bucket: string; count: number }> = [];
  if (!Array.isArray(reply)) return out;
  for (let i = 1; i < reply.length; i++) {
    const row = reply[i];
    const m: Record<string, string> = {};
    if (Array.isArray(row)) {
      for (let j = 0; j < row.length; j += 2) {
        m[String(row[j]).replace(/^@/, "")] = String(row[j + 1]);
      }
    } else if (row && typeof row === "object") {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        m[k.replace(/^@/, "")] = String(v);
      }
    }
    if (m.risk_class && m.bucket) {
      const n = Number(m.count ?? 0);
      out.push({ risk_class: m.risk_class, bucket: m.bucket, count: Number.isFinite(n) ? n : 0 });
    }
  }
  return out;
}
