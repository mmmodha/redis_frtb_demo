// Wave 6.39.B — Bucket-level K_b cache. Mirrors the Wave 5.83C-2 calc-cache
// shape, but caches per-bucket K_b in Redis (HASH) instead of full /calc
// responses in-process. Each cache entry stores the computed K_b plus a
// SHA1 content-hash of the underlying rollup HVALS so a content drift
// (HINCRBYFLOAT bumping sum_ws) is detected on the next read and the entry
// is recomputed + replaced.

import { describe, it, expect, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis.ts";
import {
  computeRollupContentHash,
  kbCacheKey,
  lookupKbCacheEntry,
  storeKbCacheEntry,
  __resetKbCacheMetricsForTests,
  getKbCacheMetrics,
  KB_CACHE_TTL_SEC,
} from "../../src/sbm/kb-cache.ts";

describe("Wave 6.39.B — sbm/kb-cache", () => {
  beforeEach(() => {
    __resetKbCacheMetricsForTests();
  });

  it("kbCacheKey builds the canonical hash-tagged shape", () => {
    expect(kbCacheKey("GIRR", "USD-IRS", "Delta", "default", "medium"))
      .toBe("kb:{GIRR:USD-IRS}:Delta:default:medium");
  });

  it("computeRollupContentHash is deterministic across field order", () => {
    const a = computeRollupContentHash({ sum_ws: "1.5", sum_ws_sq: "2.25", count: "3" });
    const b = computeRollupContentHash({ count: "3", sum_ws_sq: "2.25", sum_ws: "1.5" });
    expect(a).toBe(b);
    // Hash changes on any value drift
    const c = computeRollupContentHash({ sum_ws: "1.6", sum_ws_sq: "2.25", count: "3" });
    expect(c).not.toBe(a);
  });

  it("lookupKbCacheEntry returns miss when the cache key is absent", async () => {
    const fr = fakeRedis();
    fr.setResponse("HMGET", () => [null, null]);
    const hit = await lookupKbCacheEntry(fr, "kb:{GIRR:USD-IRS}:Delta:default:medium", "abc");
    expect(hit).toBeNull();
    expect(getKbCacheMetrics()).toEqual({ hit: 0, miss: 1, skip_filtered: 0 });
  });

  it("lookupKbCacheEntry returns hit when content hash matches", async () => {
    const fr = fakeRedis();
    fr.setResponse("HMGET", () => ["12.345", "abc"]);
    const hit = await lookupKbCacheEntry(fr, "kb:{GIRR:USD-IRS}:Delta:default:medium", "abc");
    expect(hit).toEqual({ K_b: 12.345, contentHash: "abc" });
    expect(getKbCacheMetrics()).toEqual({ hit: 1, miss: 0, skip_filtered: 0 });
  });

  it("lookupKbCacheEntry returns miss when content hash mismatches (content drift)", async () => {
    const fr = fakeRedis();
    fr.setResponse("HMGET", () => ["12.345", "stale-hash"]);
    const hit = await lookupKbCacheEntry(fr, "kb:{GIRR:USD-IRS}:Delta:default:medium", "fresh-hash");
    expect(hit).toBeNull();
    expect(getKbCacheMetrics()).toEqual({ hit: 0, miss: 1, skip_filtered: 0 });
  });

  it("storeKbCacheEntry writes K_b + content_hash with the configured TTL", async () => {
    const fr = fakeRedis();
    fr.setResponse("HSET", () => 2);
    fr.setResponse("EXPIRE", () => 1);
    await storeKbCacheEntry(fr, "kb:{GIRR:USD-IRS}:Delta:default:medium", 42.5, "hash-a");
    const hsetCall = fr.calls.find((c) => c.command === "HSET");
    const expireCall = fr.calls.find((c) => c.command === "EXPIRE");
    expect(hsetCall).toBeDefined();
    expect(hsetCall!.args[0]).toBe("kb:{GIRR:USD-IRS}:Delta:default:medium");
    expect(hsetCall!.args).toContain("K_b");
    expect(hsetCall!.args).toContain("42.5");
    expect(hsetCall!.args).toContain("content_hash");
    expect(hsetCall!.args).toContain("hash-a");
    expect(expireCall).toBeDefined();
    expect(expireCall!.args[0]).toBe("kb:{GIRR:USD-IRS}:Delta:default:medium");
    expect(Number(expireCall!.args[1])).toBe(KB_CACHE_TTL_SEC);
  });

  it("storeKbCacheEntry honours KB_CACHE_TTL_SEC override", async () => {
    const fr = fakeRedis();
    fr.setResponse("HSET", () => 2);
    fr.setResponse("EXPIRE", () => 1);
    const prev = process.env.KB_CACHE_TTL_SEC;
    process.env.KB_CACHE_TTL_SEC = "120";
    try {
      await storeKbCacheEntry(fr, "kb:{GIRR:USD-IRS}:Delta:default:medium", 1, "h");
      const expireCall = fr.calls.find((c) => c.command === "EXPIRE");
      expect(Number(expireCall!.args[1])).toBe(120);
    } finally {
      if (prev === undefined) delete process.env.KB_CACHE_TTL_SEC;
      else process.env.KB_CACHE_TTL_SEC = prev;
    }
  });
});
