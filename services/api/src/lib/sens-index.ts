// Wave 6.18i — versioned sens-index name resolution.
//
// All FT.AGGREGATE / FT.SEARCH / FT.INFO callers resolve the live index name
// via getSensIndexName(client, target_label) instead of hardcoding "idx:sens".
// The bootstrap path SETs `bootstrap:schema-hash:{target_label}` after each
// successful (re)create; the helper reads that key and returns
// `idx:sens:v{hash7}`. Missing key (cold target, legacy demo) falls back to
// the unversioned "idx:sens" so pre-6.18i targets keep working.
//
// Cached per target_label for ~30s to keep the hot path off Redis on every
// /pivot, /facets, /calc/sbm request. Bootstrap clears the cache after a
// successful rebuild via clearSensIndexNameCache(target_label).

import type { RedisLike } from "../redis-like.ts";

export const BASE_INDEX_NAME = "idx:sens";
// Wave 6.18j — sentinel prefix marking that the persisted hash key refers to
// the unversioned `idx:sens` we adopted on first migration over a populated
// pre-6.18i cluster. Plain string prefix so `redis-cli GET` reveals state.
export const LEGACY_HASH_PREFIX = "legacy:";
const HASH_PREFIX_LEN = 7;
const CACHE_TTL_MS = 30_000;

export function versionedIndexName(hash: string): string {
  return `${BASE_INDEX_NAME}:v${hash.slice(0, HASH_PREFIX_LEN)}`;
}

export function schemaHashKey(target_label: string): string {
  return `bootstrap:schema-hash:${target_label}`;
}

interface CacheEntry { name: string; expiresAt: number }
const cache = new Map<string, CacheEntry>();

export function clearSensIndexNameCache(target_label?: string): void {
  if (target_label === undefined) cache.clear();
  else cache.delete(target_label);
}

export async function getSensIndexName(
  client: RedisLike,
  target_label: string,
): Promise<string> {
  const now = Date.now();
  const cached = cache.get(target_label);
  if (cached && cached.expiresAt > now) return cached.name;
  let name = BASE_INDEX_NAME;
  try {
    const reply = await client.call("GET", schemaHashKey(target_label));
    if (typeof reply === "string") {
      if (reply.startsWith(LEGACY_HASH_PREFIX)) {
        // Wave 6.18j — adopted legacy index: bootstrap left the docs under the
        // unversioned `idx:sens` and tagged the hash key with a `legacy:`
        // prefix. Routes keep targeting the literal base name.
        name = BASE_INDEX_NAME;
      } else if (reply.length >= HASH_PREFIX_LEN) {
        name = versionedIndexName(reply);
      }
    }
  } catch {
    // GET failure (key missing, transient cluster error, fake without a
    // GET responder) → fall back to the legacy base name. Routes still
    // work against pre-6.18i targets where the index exists under
    // "idx:sens" without a hash key.
  }
  cache.set(target_label, { name, expiresAt: now + CACHE_TTL_MS });
  return name;
}
