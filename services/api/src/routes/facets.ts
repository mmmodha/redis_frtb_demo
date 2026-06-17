import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget, onActiveTargetChange } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";

// Wave 5.56 / 5.66 — facet counts backing the Search / Calc / JSON Explorer
// dropdowns. We aggregate grouped (risk_class, bucket, sensitivity_type)
// counts so the UI can hide classes/buckets/sens-types that report zero rows
// in the active index instead of presenting all 7×16×3 hardcoded combinations.
//
// Wave 5.67 — Short-TTL (30 s) in-process cache. Re-opening Search / Calc /
// JSON Explorer in quick succession used to pay the full aggregate cost
// (~2-3 s on 220k rows) each time. We cache the response body keyed by the
// active-target IDENTITY tuple (host/port/db/tls/clusterMode) — label is
// intentionally excluded so a rename of the currently-active profile does
// NOT invalidate the cache. `setActiveTarget` (identity / creds rotation)
// fires `onActiveTargetChange`, which clears the cache immediately. No
// generator-finish event exists today; a fresh ingest will be picked up by
// the next call after TTL expiry.
//
// Wave 6.18g — Previously this route used a cursor-driven aggregate to drain
// grouped rows. Against a clustered Redis fronted by a proxy, the cursor
// opened on one shard frequently failed on subsequent reads ("Cursor not
// found, id: …") because the proxy could route the follow-up to a different
// node, the idle TTL could reap the cursor between calls, or cursor ids could
// collide across shards. The bounded result set (≤ MAX_GROUPS) is exactly
// what FT.AGGREGATE ... LIMIT 0 N is designed for, so we now issue a single-
// shot aggregate with no cursor lifecycle.

const MAX_GROUPS = 50000;
const CACHE_TTL_MS = 30_000;

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
// intentionally does NOT, so renames preserve the cache). Registered at
// module load — listeners are stored in a Set so this is idempotent across
// repeated server instantiations in tests.
onActiveTargetChange(() => {
  cache = null;
});

// Exported for tests so module-global cache state can be reset between cases
// without restarting the test runner.
export function __resetFacetsCacheForTests(): void {
  cache = null;
}

// Wave 5.86C — POST /admin/flush invokes this after FLUSHDB + bootstrap so the
// next /facets call drains the freshly-rebuilt index instead of serving the
// pre-flush body for up to CACHE_TTL_MS. The active-target identity has not
// changed, so onActiveTargetChange does not fire on its own.
export function invalidateFacetsCache(): void {
  cache = null;
}

// FT.AGGREGATE returns the standard payload [N, row1, row2, ...] where each
// row is a flat [field, val, ...] array.
function parseAggregateRows(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (!Array.isArray(row)) continue;
    const m: Record<string, string> = {};
    for (let j = 0; j < row.length; j += 2) {
      const k = row[j];
      const v = row[j + 1];
      if (typeof k === "string") m[k] = v === undefined || v === null ? "" : String(v);
    }
    out.push(m);
  }
  return out;
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

export function registerFacetsRoute(
  app: FastifyInstance,
  getRedis: () => RedisLike,
): void {
  app.get("/facets", async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    const key = identityKey();
    const now = Date.now();
    if (cache && cache.key === key && cache.expiresAt > now) {
      const ms = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
      return { ...cache.body, ms, cached: true };
    }

    const redis = getRedis();
    const target_label = getActiveTarget().label;

    let rows: Array<Record<string, string>> = [];
    try {
      // Single-shot bounded aggregate. MAX_GROUPS caps the result set the
      // same way the previous cursor-drain did, but without the proxy /
      // cluster-routing failure modes of the follow-up cursor reads.
      const reply = await redis.call(
        "FT.AGGREGATE",
        "idx:sens",
        "*",
        "GROUPBY",
        "3",
        "@risk_class",
        "@bucket",
        "@sensitivity_type",
        "REDUCE",
        "COUNT",
        "0",
        "AS",
        "n",
        "LIMIT",
        "0",
        String(MAX_GROUPS),
        "DIALECT",
        "2",
      );
      rows = parseAggregateRows(reply);
    } catch (err) {
      const ms = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
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

    const ms = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;

    if (rows.length === 0) {
      const body = emptyResponse(target_label, ms);
      cache = { key, body, expiresAt: Date.now() + CACHE_TTL_MS };
      return body;
    }

    const risk_class: Record<string, number> = {};
    const sensitivity_type: Record<string, number> = {};
    const bucket_by_risk_class: Record<string, Record<string, number>> = {};
    let total_rows = 0;

    for (const row of rows) {
      const rc = row.risk_class ?? "";
      const bk = row.bucket ?? "";
      const st = row.sensitivity_type ?? "";
      const n = Number(row.n);
      if (!Number.isFinite(n) || n <= 0) continue;
      total_rows += n;
      if (rc) risk_class[rc] = (risk_class[rc] ?? 0) + n;
      if (st) sensitivity_type[st] = (sensitivity_type[st] ?? 0) + n;
      if (rc && bk) {
        const inner = bucket_by_risk_class[rc] ?? (bucket_by_risk_class[rc] = {});
        inner[bk] = (inner[bk] ?? 0) + n;
      }
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
