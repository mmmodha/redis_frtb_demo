// Wave 6.18i — versioned sens-index name resolution.
//
// All FT.AGGREGATE / FT.SEARCH / FT.INFO callers resolve the live index name
// via getSensIndexName(client, target_label) instead of hardcoding "idx:sens".
// The bootstrap path SETs `bootstrap:schema-hash:{target_label}` after each
// successful (re)create; the helper reads that key and returns
// `idx:sens:v{hash7}`. Missing key (cold target, legacy demo) falls back to
// the unversioned "idx:sens" so pre-6.18i targets keep working.
//
// Wave 6.38.A — the 30s per-target_label Map cache (introduced in 6.18i to
// keep the hot path off Redis on every /pivot, /facets, /calc/sbm request)
// has been removed. Wave 6.30.B2.1 active-target gating + Wave 6.36
// connection-pool readiness probe collapse the in-flight cost of the
// `GET bootstrap:schema-hash:{...}` call to a single round-trip — and the
// cache was masking real stale-name issues during fast index swaps.
// `clearSensIndexNameCache` is retained as a no-op shim so call-sites in
// bootstrap.ts and the cluster-recovery integration tests keep compiling.

import type { RedisLike } from "../redis-like.ts";

export const BASE_INDEX_NAME = "idx:sens";
// Wave 6.18j — sentinel prefix marking that the persisted hash key refers to
// the unversioned `idx:sens` we adopted on first migration over a populated
// pre-6.18i cluster. Plain string prefix so `redis-cli GET` reveals state.
export const LEGACY_HASH_PREFIX = "legacy:";
const HASH_PREFIX_LEN = 7;

export function versionedIndexName(hash: string): string {
  return `${BASE_INDEX_NAME}:v${hash.slice(0, HASH_PREFIX_LEN)}`;
}

export function schemaHashKey(target_label: string): string {
  return `bootstrap:schema-hash:${target_label}`;
}

// Wave 6.38.A — retained as a no-op shim. Pre-existing call-sites (bootstrap
// post-rebuild, cluster-recovery tests) keep invoking it; the underlying
// cache was deleted in the same wave so the call is now free.
export function clearSensIndexNameCache(_target_label?: string): void {
  void _target_label;
}

export async function getSensIndexName(
  client: RedisLike,
  target_label: string,
): Promise<string> {
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
  return name;
}
