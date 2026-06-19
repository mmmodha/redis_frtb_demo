// Wave 6.41.E.fix5 — probe & cache the RediSearch module major version per
// RedisLike connection. Used by the FT.AGGREGATE builders to choose between
// the v2 null-coercion idiom (`@f+0`) and the v8 form (`case(exists(@f),@f,0)`).

import { describe, it, expect, beforeEach } from "vitest";
import {
  getSearchModuleMajorVersion,
  __resetSearchModuleVersionCacheForTests,
} from "../src/lib/search-module-version.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

// MODULE LIST reply shape mirrors what ioredis surfaces — an array of entries
// where each entry is a flat [field, value, field, value, ...] pair list.
function moduleListV8(): unknown {
  return [
    ["name", "search", "ver", 80606, "path", "/opt/redis-stack/lib/redisearch.so"],
    ["name", "ReJSON", "ver", 20800],
  ];
}

function moduleListV2(): unknown {
  return [
    ["name", "search", "ver", 21027, "path", "/usr/lib/redis/modules/redisearch.so"],
    ["name", "ReJSON", "ver", 20803],
  ];
}

function moduleListNoSearch(): unknown {
  return [
    ["name", "ReJSON", "ver", 20803],
    ["name", "timeseries", "ver", 20800],
  ];
}

describe("getSearchModuleMajorVersion", () => {
  beforeEach(() => {
    __resetSearchModuleVersionCacheForTests();
  });

  it("returns 80606 when search module advertises ver=80606 (RediSearch 8.x)", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListV8());
    const ver = await getSearchModuleMajorVersion(fr);
    expect(ver).toBe(80606);
  });

  it("returns 21027 when search module advertises ver=21027 (RediSearch 2.10.x)", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListV2());
    const ver = await getSearchModuleMajorVersion(fr);
    expect(ver).toBe(21027);
  });

  it("returns 0 when MODULE LIST has no search entry", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListNoSearch());
    const ver = await getSearchModuleMajorVersion(fr);
    expect(ver).toBe(0);
  });

  it("returns 0 on a malformed MODULE LIST reply", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", "not-an-array");
    const ver = await getSearchModuleMajorVersion(fr);
    expect(ver).toBe(0);
  });

  it("returns 0 when MODULE LIST throws (module command unavailable)", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", () => {
      throw new Error("ERR unknown command 'MODULE'");
    });
    const ver = await getSearchModuleMajorVersion(fr);
    expect(ver).toBe(0);
  });

  it("caches per-connection — MODULE LIST is probed exactly once across many calls", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListV8());
    const a = await getSearchModuleMajorVersion(fr);
    const b = await getSearchModuleMajorVersion(fr);
    const c = await getSearchModuleMajorVersion(fr);
    expect(a).toBe(80606);
    expect(b).toBe(80606);
    expect(c).toBe(80606);
    const probes = fr.calls.filter((c) => c.command === "MODULE");
    expect(probes).toHaveLength(1);
    // And the probe argv is exactly `MODULE LIST`.
    expect(probes[0]!.args).toEqual(["LIST"]);
  });

  it("does NOT cache a 0-result (transient probe miss re-runs on next call)", async () => {
    // Reproduces the cold-start race seen on davpin: the first MODULE LIST
    // returned a non-array reply (resolved as 0); caching that value would
    // strand the builders on `@f+0` forever and surface SEARCH_EXPR errors
    // even though every subsequent probe would correctly return 80606.
    const fr = fakeRedis();
    let probeCount = 0;
    fr.setResponse("MODULE", () => {
      probeCount += 1;
      return probeCount === 1 ? "transient-non-array" : moduleListV8();
    });
    expect(await getSearchModuleMajorVersion(fr)).toBe(0);
    expect(await getSearchModuleMajorVersion(fr)).toBe(80606);
    // The second call re-probed because the 0-result was not cached.
    expect(probeCount).toBe(2);
    // After the successful probe, further calls hit the cache.
    expect(await getSearchModuleMajorVersion(fr)).toBe(80606);
    expect(probeCount).toBe(2);
  });

  it("treats distinct RedisLike instances as independent cache entries", async () => {
    const a = fakeRedis();
    const b = fakeRedis();
    a.setResponse("MODULE", moduleListV8());
    b.setResponse("MODULE", moduleListV2());
    expect(await getSearchModuleMajorVersion(a)).toBe(80606);
    expect(await getSearchModuleMajorVersion(b)).toBe(21027);
    // Each only probed once.
    expect(a.calls.filter((c) => c.command === "MODULE")).toHaveLength(1);
    expect(b.calls.filter((c) => c.command === "MODULE")).toHaveLength(1);
  });
});
