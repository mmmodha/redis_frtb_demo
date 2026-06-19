// Wave 6.41.E.fix5 — probe & cache the connected cluster's RediSearch module
// version so the FT.AGGREGATE builders can choose between the v2 null-coercion
// idiom (`@f+0`) and the v8 form (`case(exists(@f),@f,0)`).
//
// Background: davpin runs RediSearch 8.6.6 which rejects `@field+0` in APPLY
// clauses with `SEARCH_EXPR Syntax error`; localcluster (RediSearch 2.10.27)
// gates the `case` function behind `ENABLE_UNSTABLE_FEATURES` and rejects it
// at runtime (FT.CONFIG / CONFIG SET both refused). No single expression
// works on both — the builders must branch on the live module version.
//
// Caching: two layers.
//   * Per-RedisLike `inFlight` WeakMap so concurrent first callers on the same
//     wrapper share a single MODULE LIST probe.
//   * Process-global `lastKnownGood` Map keyed by the active-target label so
//     once ANY caller has successfully resolved the version on the active
//     cluster, every subsequent caller — including ones whose own pool-member
//     probe fails with "Stream isn't writeable" (transient ioredis offline
//     state during pool rotation/half-open recycle) — reuses the resolved
//     value rather than falling back to 0 and emitting the wrong APPLY shape.
//     A target switch flips the label so the new cluster's version is
//     re-probed naturally.

import type { RedisLike } from "../redis-like.ts";
import { getActiveRedisClient, getActiveTarget } from "../active-target.ts";

// Per-wrapper in-flight probe coalescing. A WeakMap so the entry vanishes when
// a recycled pool member's wrapper is GC'd.
let inFlight = new WeakMap<RedisLike, Promise<number>>();

// Last successfully resolved `ver` per target label. Survives pool-member
// recycles (the underlying cluster's module version does not change between
// calls) and is invalidated implicitly by `__resetSearchModuleVersionCacheFor
// Tests` and by target switches (different label ⇒ different key).
const lastKnownGood = new Map<string, number>();

// Optional cache-key override for tests that do not stand up the active-target
// singleton. When set, `getSearchModuleMajorVersion` keys `lastKnownGood` on
// this string instead of `getActiveTarget().label`.
let testCacheKeyOverride: string | null = null;

// Test seam — vitest cases run against synthetic RedisLike fakes that DO get
// reused across cases; without an explicit reset the cached probe verdict
// would bleed between tests. Production code never calls this.
// Setting a non-null `cacheKey` (default "__test__") also flips probe() into
// test-only mode: the boot-client path is skipped so the unit suite never
// blocks waiting on a real Redis socket. Pass an explicit `null` to opt out.
export function __resetSearchModuleVersionCacheForTests(
  cacheKey: string | null = "__test__",
): void {
  inFlight = new WeakMap<RedisLike, Promise<number>>();
  lastKnownGood.clear();
  testCacheKeyOverride = cacheKey;
}

// Parse one MODULE LIST entry (flat [field, value, field, value, ...]) into a
// {name, ver} pair. Tolerant of mixed-case `name` keys and string-or-number
// `ver` values (ioredis surfaces integers; some fakes use strings).
function parseEntry(entry: unknown): { name: string; ver: number } | null {
  if (!Array.isArray(entry)) return null;
  let name: string | null = null;
  let ver = 0;
  for (let i = 0; i + 1 < entry.length; i += 2) {
    const k = entry[i];
    const v = entry[i + 1];
    if (typeof k !== "string") continue;
    const kl = k.toLowerCase();
    if (kl === "name" && typeof v === "string") name = v.toLowerCase();
    else if (kl === "ver") {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) ver = Math.trunc(n);
    }
  }
  return name ? { name, ver } : null;
}

function parseModuleList(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  for (const entry of raw) {
    const p = parseEntry(entry);
    if (p && p.name === "search") return p.ver;
  }
  return 0;
}

async function probe(redis: RedisLike): Promise<number> {
  // Tests set `testCacheKeyOverride` and exercise the helper against synthetic
  // RedisLike fakes — skip the boot-client path entirely in that mode so a
  // missing active-target singleton cannot stall the unit suite waiting on a
  // real socket. Production code that has not explicitly activated a profile
  // (active-target label === "default", i.e. the un-set fallback) is treated
  // the same way: we have nothing to gain from probing the loopback default.
  const useBoot = testCacheKeyOverride === null && resolveCacheKey() !== "default";
  if (useBoot) {
    // Prefer the boot client (offline queue enabled, default ioredis retry
    // budget) for the probe so a pool-member wrapper in mid-recycle does not
    // reject MODULE LIST with "Stream isn't writeable". The boot client is a
    // long-lived singleton keyed on the active target; on a target swap it
    // is disconnected and rebuilt before the next caller observes the change.
    const boot = (() => {
      try { return getActiveRedisClient(); } catch { return null; }
    })();
    if (boot) {
      try {
        return parseModuleList(await boot.call("MODULE", "LIST"));
      } catch {
        // Fall through to the RedisLike-based probe below.
      }
    }
  }
  try {
    return parseModuleList(await redis.call("MODULE", "LIST"));
  } catch {
    return 0;
  }
}

function resolveCacheKey(): string {
  if (testCacheKeyOverride !== null) return testCacheKeyOverride;
  try {
    return getActiveTarget().label;
  } catch {
    return "";
  }
}

// Returns the search module's numeric `ver` (e.g. 21027 for 2.10.27, 80606
// for 8.6.6) or 0 when the module is absent / MODULE LIST fails AND no prior
// successful probe exists for the active target.
//
// A 0 from a single probe is treated as a transient miss (e.g. a pool-member
// wrapper whose underlying ioredis socket is mid-recycle and rejects with
// "Stream isn't writeable"): we DO NOT store it in `lastKnownGood`, so the
// next caller hitting a healthy wrapper still gets to record the real value.
// If `lastKnownGood` already holds a value for this target, we return that
// instead of 0 — once a single caller has resolved the cluster's version,
// every subsequent caller benefits even if their own probe fails.
export function getSearchModuleMajorVersion(redis: RedisLike): Promise<number> {
  const hit = inFlight.get(redis);
  if (hit) return hit;
  const key = resolveCacheKey();
  const pending = probe(redis).then((ver) => {
    if (ver > 0) {
      if (key !== "") lastKnownGood.set(key, ver);
      return ver;
    }
    // Probe failed; fall back to a previously-cached good value for this
    // target if one exists. Drop the in-flight entry so the next caller on
    // a (likely healthier) wrapper re-probes.
    inFlight.delete(redis);
    const cached = key !== "" ? lastKnownGood.get(key) : undefined;
    return cached ?? 0;
  });
  inFlight.set(redis, pending);
  return pending;
}
