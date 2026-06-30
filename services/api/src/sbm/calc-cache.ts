// Wave 5.83C-2 — Short-TTL (30 s) in-process response cache for /calc/sbm.
//
// Mirrors the Wave 5.67 /facets cache pattern: a single module-global Map
// keyed by the canonical request body + a data-version stamp, cleared on
// active-target change so a profile switch never serves a stale charge.
//
// The version stamp lives in Redis under `calc:data_version` and is INCR'd
// by the /admin/flush handler (which wipes the underlying data) and by the
// admin/rebuild-indexes path. We cache the value in-process so the per-call
// GET overhead only happens on the first lookup after a bump / target switch.

import type { RedisLike } from "../redis-like.ts";
import { onActiveTargetChange } from "../active-target.ts";

const TTL_MS = 30_000;
const DATA_VERSION_KEY = "calc:data_version";

interface Entry {
  value: unknown;
  expiresAt: number;
  cachedAtIso: string;
}

const cache = new Map<string, Entry>();
let dataVersion: number | null = null;

// Identity / creds rotation fires onActiveTargetChange. The new target has
// its own keyspace and `calc:data_version`, so drop everything and re-read
// on the next request.
onActiveTargetChange(() => {
  cache.clear();
  dataVersion = null;
});

// Exported for tests so the module-global cache and cached version can be
// reset between cases without restarting the test runner.
export function __resetCalcCacheForTests(): void {
  cache.clear();
  dataVersion = null;
}

// Stable JSON: object keys sorted recursively. Arrays preserve order — the
// caller is expected to canonicalise set-valued fields (e.g. bucket_subset)
// before passing them in, so two requests with different array order on a
// set-valued field deliberately get different cache entries unless the
// caller normalises first.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

export function calcCacheKey(body: unknown, version: number): string {
  return `${version}:${JSON.stringify(canonicalize(body))}`;
}

// Lazy: first call after process start / flush / target-switch hits Redis;
// subsequent calls in the same window reuse the in-memory copy. A failed
// GET (key missing on a fresh target, redis unreachable) is treated as
// version 0 so the cache still functions in degraded modes.
export async function getDataVersion(redis: RedisLike): Promise<number> {
  if (dataVersion !== null) return dataVersion;
  try {
    const raw = await redis.call("GET", DATA_VERSION_KEY);
    const n = Number(raw);
    dataVersion = Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    dataVersion = 0;
  }
  return dataVersion;
}

// INCR the Redis stamp, refresh the local copy, and drop all cached entries
// so the bump takes effect even on a single-process deployment. Returns the
// new version. Errors fall back to a local-only bump so the cache is still
// invalidated when Redis is briefly unavailable.
export async function bumpDataVersion(redis: RedisLike): Promise<number> {
  let next: number;
  try {
    const raw = await redis.call("INCR", DATA_VERSION_KEY);
    const n = Number(raw);
    next = Number.isFinite(n) && n > 0 ? n : (dataVersion ?? 0) + 1;
  } catch {
    next = (dataVersion ?? 0) + 1;
  }
  dataVersion = next;
  cache.clear();
  return next;
}

export interface CacheHit {
  value: unknown;
  cachedAtIso: string;
}

export function lookupCalcCache(key: string): CacheHit | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return { value: entry.value, cachedAtIso: entry.cachedAtIso };
}

export function storeCalcCache(key: string, value: unknown): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + CALC_CACHE_TTL_MS,
    cachedAtIso: new Date().toISOString(),
  });
}

export const CALC_CACHE_TTL_MS = readCalcCacheTtlMs();

function readCalcCacheTtlMs(): number {
  const raw = process.env.CALC_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : TTL_MS;
}
export const CALC_DATA_VERSION_KEY = DATA_VERSION_KEY;
