import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, type Schema } from "@frtb/schema";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget, onActiveTargetChange } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { getSensIndexName } from "../lib/sens-index.ts";
import { translateRedisError } from "../redis-errors.ts";

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
// Wave 6.25 — FT.AGGREGATE GROUPBY against the clustered Redis proxy returned
// 0 rows even with DIALECT 1/2/3/4 and WITHCURSOR; the cluster simply does not
// drain grouped rows reliably for us. We now derive the facet counts by
// issuing one `FT.SEARCH <idx> "<tag-filter>" LIMIT 0 0` per known tag value
// in the active schema and reading the total-count head of the reply. The
// route's external FacetsResponseOk / FacetsResponseEmpty shape is unchanged.
//
// Wave 6.27 — the ~95 per-tag FT.SEARCH calls now ship in a single MULTI/EXEC
// pipeline instead of independent Promise.all() round-trips. On bigcluster
// (~150 ms RTT to the DMC proxy) this collapses 95 × RTT to ~1 × RTT and cuts
// uncached /facets from 15.2 s to sub-second. Production clients (ioredis
// Redis | Cluster) expose `.multi()`; the per-call fallback below is kept for
// any RedisLike implementation that does not (currently none in tree).

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

// Identity / creds rotation fires onActiveTargetChange (setActiveTargetLabel
// intentionally does NOT, so renames preserve the cache).
onActiveTargetChange(() => {
  cache = null;
});

export function __resetFacetsCacheForTests(): void {
  cache = null;
}

// Wave 5.86C — POST /admin/flush invokes this after FLUSHDB + bootstrap so the
// next /facets call sees the freshly-rebuilt index instead of the pre-flush
// body for up to CACHE_TTL_MS.
export function invalidateFacetsCache(): void {
  cache = null;
}

function isUnknownIndexError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  // Redis 8.x reports the missing-index condition as
  // "SEARCH_INDEX_NOT_FOUND Index not found: …" — accept it alongside the
  // legacy RediSearch phrasings.
  return (
    msg.includes("unknown index name") ||
    msg.includes("no such index") ||
    msg.includes("index not found")
  );
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

// RediSearch TAG queries require backslash-escaping of punctuation. The
// default schema's bucket values are alphanumeric, but the schema is
// hot-swappable so we escape defensively.
function escapeTag(v: string): string {
  return v.replace(/[\\,.<>{}[\]"':;!@#$%^&*()\-+=~/ \t]/g, "\\$&");
}

// FT.SEARCH ... LIMIT 0 0 returns RESP2 `[total_count]` (only the count head;
// no document payload). Extract it defensively.
function searchCountReply(reply: unknown): number {
  if (Array.isArray(reply) && reply.length > 0) {
    const n = Number(reply[0]);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
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

// Structural type for the ioredis MULTI surface — both `Redis` and `Cluster`
// expose `.multi()` returning a chainable pipeline whose `.exec()` resolves to
// the `[err, reply]` tuple array. Widened here rather than added to RedisLike
// so the narrow interface stays minimal (same pattern as PipelineClient in
// generator.ts).
type MultiClient = {
  multi(): {
    call(command: string, ...args: unknown[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
};

function hasMulti(r: RedisLike): r is RedisLike & MultiClient {
  return typeof (r as unknown as Partial<MultiClient>).multi === "function";
}

// Run the ordered list of FT.SEARCH count queries against `indexName`. When
// the client supports MULTI/EXEC (production: ioredis Redis|Cluster) we pack
// them into a single pipeline — the win is amortizing RTT, which dominates on
// the cloud DMC proxy. The fallback path keeps a parallel Promise.all so
// minimal stubs without `.multi()` (none currently in tree) still work. The
// LIMIT 0 0 (count-only) trick is preserved in both paths.
async function runFacetSearches(
  redis: RedisLike,
  indexName: string,
  queries: string[],
): Promise<unknown[]> {
  if (hasMulti(redis)) {
    const pipeline = redis.multi();
    for (const q of queries) {
      pipeline.call("FT.SEARCH", indexName, q, "LIMIT", "0", "0");
    }
    const results = await pipeline.exec();
    if (!results) {
      // ioredis returns null when the transaction was discarded (e.g. WATCH
      // aborted). We don't use WATCH here, but surface a recognisable error
      // rather than silently returning empty counts.
      throw new Error("FT.SEARCH MULTI/EXEC returned null");
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
  return Promise.all(
    queries.map((q) =>
      redis.call("FT.SEARCH", indexName, q, "LIMIT", "0", "0"),
    ),
  );
}

export function registerFacetsRoute(
  app: FastifyInstance,
  getRedis: () => RedisLike,
  opts: { schema?: Schema } = {},
): void {
  app.get("/facets", async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    const key = identityKey();
    const now = Date.now();
    if (cache && cache.key === key && cache.expiresAt > now) {
      const ms = elapsedMs(t0);
      return { ...cache.body, ms, cached: true };
    }

    const redis = getRedis();
    const target_label = getActiveTarget().label;
    // Wave 6.18i — resolve the live versioned index name (cached 30 s).
    const indexName = await getSensIndexName(redis, target_label);

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
    const sensitivityTypes = SENSITIVITY_TYPES;
    const bucketTuples: Array<[string, string]> = [];
    for (const rc of riskClasses) {
      const cfg = schema.risk_classes[rc];
      const buckets = cfg?.buckets?.values ?? [];
      for (const bk of buckets) bucketTuples.push([rc, bk]);
    }

    // FT.SEARCH count fan-out. Each call returns `[N, ...docs]`; with LIMIT
    // 0 0 there are no docs — just N. We build one ordered list of queries
    // (risk_class, sensitivity_type, (rc, bucket)) and ship them through a
    // single MULTI/EXEC pipeline so all ~95 commands amortize one RTT (Wave
    // 6.27). The reply array is sliced back into the three groupings in the
    // same order they were enqueued.
    const rcQueries = riskClasses.map(
      (rc) => `@risk_class:{${escapeTag(rc)}}`,
    );
    const stQueries = sensitivityTypes.map(
      (st) => `@sensitivity_type:{${escapeTag(st)}}`,
    );
    const bkQueries = bucketTuples.map(
      ([rc, bk]) =>
        `@risk_class:{${escapeTag(rc)}} @bucket:{${escapeTag(bk)}}`,
    );
    const allQueries = [...rcQueries, ...stQueries, ...bkQueries];

    let allReplies: unknown[];
    try {
      allReplies = await runFacetSearches(redis, indexName, allQueries);
    } catch (err) {
      const ms = elapsedMs(t0);
      // The spec asks for a 200 empty-index shape when idx:sens is missing,
      // overriding the 412 translateRedisError would otherwise return.
      if (isUnknownIndexError(err)) {
        const body = emptyResponse(target_label, ms);
        cache = { key, body, expiresAt: Date.now() + CACHE_TTL_MS };
        return body;
      }
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

    const rcEnd = rcQueries.length;
    const stEnd = rcEnd + stQueries.length;
    const rcReplies = allReplies.slice(0, rcEnd);
    const stReplies = allReplies.slice(rcEnd, stEnd);
    const bkReplies = allReplies.slice(stEnd);

    const risk_class: Record<string, number> = {};
    const sensitivity_type: Record<string, number> = {};
    const bucket_by_risk_class: Record<string, Record<string, number>> = {};

    riskClasses.forEach((rc, i) => {
      const n = searchCountReply(rcReplies[i]);
      if (n > 0) risk_class[rc] = n;
    });
    sensitivityTypes.forEach((st, i) => {
      const n = searchCountReply(stReplies[i]);
      if (n > 0) sensitivity_type[st] = n;
    });
    bucketTuples.forEach(([rc, bk], i) => {
      const n = searchCountReply(bkReplies[i]);
      if (n <= 0) return;
      const inner = bucket_by_risk_class[rc] ?? (bucket_by_risk_class[rc] = {});
      inner[bk] = n;
    });

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
}
