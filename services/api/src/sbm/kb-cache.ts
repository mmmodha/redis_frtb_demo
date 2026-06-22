// Wave 6.39.B — Bucket-level K_b cache.
//
// Caches the per-bucket K_b computed by the rollup-readout fast path so a
// warm /calc/sbm/total request avoids re-running the per-bucket math 270
// times (one per (rc, bucket, sens, scenario, regime) tuple). The cache
// lives in Redis as a small HASH per tuple so a multi-process api fleet
// shares the same warm set; the value carries a SHA1 content-hash of the
// underlying rollup hash so a content drift (HINCRBYFLOAT bumping sum_ws
// after ingest applies a new delta) invalidates the entry on the very
// next read without an explicit DEL.
//
// Key shape: `kb:{<rc>:<bkt>}:<sens>:<scenario>:<regime>` — the literal
// `{...}` hash-tag wraps the (rc, bucket) pair, matching the
// `rollup:<rc>:<bkt>:…` (Wave 7.0.6.6 tag-free) and `sens:{<rc>:<bkt>}:…` shape so a single slot
// owns all bucket-scoped state in cluster mode. Two HMGETs per bucket
// (kb-key + rollup-key content_hash check) stay slot-local.
//
// Counters: in-process `hit` / `miss` totals exposed via /metrics. Reset
// only by `__resetKbCacheMetricsForTests`; production never resets so the
// counters are monotonic-since-boot.

import { createHash } from "node:crypto";
import type { RedisLike } from "../redis-like.ts";

export const KB_CACHE_TTL_SEC_DEFAULT = 3600;

// Read the configured TTL at call time so an operator can flip
// KB_CACHE_TTL_SEC without restarting. Falsy / non-numeric values fall
// back to the 60-minute default.
export function getKbCacheTtlSec(): number {
  const raw = process.env.KB_CACHE_TTL_SEC;
  if (!raw) return KB_CACHE_TTL_SEC_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : KB_CACHE_TTL_SEC_DEFAULT;
}

// Public symbol kept for tests that pin the default — production reads
// via `getKbCacheTtlSec()` so a runtime override always wins.
export const KB_CACHE_TTL_SEC = KB_CACHE_TTL_SEC_DEFAULT;

export function kbCacheKey(
  rc: string,
  bkt: string,
  sens: string,
  scenario: string,
  regime: string,
): string {
  return `kb:{${rc}:${bkt}}:${sens}:${scenario}:${regime}`;
}

// SHA1 over the sorted (field, value) pairs of the rollup HASH. Stable
// across RESP2 / RESP3 reply ordering since we sort by field name before
// hashing. Numeric coercion happens at the K_b compute step, not here —
// the hash is taken over the raw string values written by ingest so a
// formatting-only drift (e.g. trailing zero) is still detected.
export function computeRollupContentHash(rollup: Record<string, string>): string {
  const keys = Object.keys(rollup).sort();
  const hash = createHash("sha1");
  for (const k of keys) {
    hash.update(k);
    hash.update("\0");
    hash.update(String(rollup[k] ?? ""));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Combined content hash across a (perTenor) family of rollup hashes. The
// caller passes them in stable insertion order (matches the schema tenor
// declaration order) so the digest is reproducible across calls.
export function combineRollupContentHashes(parts: ReadonlyArray<string>): string {
  if (parts.length === 1) return parts[0]!;
  const hash = createHash("sha1");
  for (const p of parts) {
    hash.update(p);
    hash.update("\0");
  }
  return hash.digest("hex");
}

let hitCount = 0;
let missCount = 0;
// Wave 6.41.A — counter for buckets whose K_b cache is intentionally
// bypassed because the request carries an include/exclude filter (the
// rollup-derived K_b doesn't account for the filter, so serving it would
// be wrong). Bumped once per skipped bucket by the calc route.
let skipFilteredCount = 0;

export function __resetKbCacheMetricsForTests(): void {
  hitCount = 0;
  missCount = 0;
  skipFilteredCount = 0;
}

export function getKbCacheMetrics(): { hit: number; miss: number; skip_filtered: number } {
  return { hit: hitCount, miss: missCount, skip_filtered: skipFilteredCount };
}

// Wave 6.41.A — invoked by the calc route when a request carries an
// include/exclude filter and the rollup-derived K_b would therefore be
// stale for this request.
export function recordKbCacheSkipFiltered(n: number = 1): void {
  skipFilteredCount += n;
}

export interface KbCacheHit {
  K_b: number;
  contentHash: string;
}

// Look up the cached K_b. Returns a `KbCacheHit` only when the cached
// content_hash matches `expectedHash` — otherwise the entry is stale and
// the caller must recompute + replace via `storeKbCacheEntry`. Misses on
// any redis error are returned as null (the rollup-readout path then
// recomputes from the rollup HASH it already has in hand).
export async function lookupKbCacheEntry(
  redis: RedisLike,
  key: string,
  expectedHash: string,
): Promise<KbCacheHit | null> {
  let reply: unknown;
  try {
    reply = await redis.call("HMGET", key, "K_b", "content_hash");
  } catch {
    missCount += 1;
    return null;
  }
  if (!Array.isArray(reply) || reply.length < 2) {
    missCount += 1;
    return null;
  }
  const rawKb = reply[0];
  const rawHash = reply[1];
  if (rawKb == null || rawHash == null) {
    missCount += 1;
    return null;
  }
  const cachedHash = String(rawHash);
  if (cachedHash !== expectedHash) {
    missCount += 1;
    return null;
  }
  const K_b = Number(rawKb);
  if (!Number.isFinite(K_b)) {
    missCount += 1;
    return null;
  }
  hitCount += 1;
  return { K_b, contentHash: cachedHash };
}

// Write the freshly-computed K_b + content hash with the configured TTL.
// Two-step HSET + EXPIRE rather than HSETEX so the shim works against
// older Redis builds (HSETEX landed in 8.2). Best-effort: errors are
// swallowed so a Redis hiccup never fails the calc that already returned
// a correct K_b from the rollup hash in hand.
export async function storeKbCacheEntry(
  redis: RedisLike,
  key: string,
  K_b: number,
  contentHash: string,
): Promise<void> {
  try {
    await redis.call("HSET", key, "K_b", String(K_b), "content_hash", contentHash);
    await redis.call("EXPIRE", key, String(getKbCacheTtlSec()));
  } catch { /* best-effort: cache write failure must not bubble to the route */ }
}
