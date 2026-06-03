import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../../src/server.ts";
import { fakeRedis } from "../helpers/fake-redis.ts";
import {
  resetTimeSeriesCacheForTests,
} from "../../src/lib/timeseries.ts";
import { setActiveTarget, resetActiveTarget } from "../../src/active-target.ts";

// MODULE LIST shape returned by ioredis for `MODULE LIST`:
//   [[name, timeseries, ver, 20800, ...], [name, search, ...], ...]
function moduleListWithTs(): unknown {
  return [
    ["name", "timeseries", "ver", 20800, "path", "/usr/lib/redis/modules/redistimeseries.so"],
    ["name", "search", "ver", 20800],
  ];
}

function moduleListWithoutTs(): unknown {
  return [
    ["name", "search", "ver", 20800],
  ];
}

describe("GET /observability/history", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    resetTimeSeriesCacheForTests();
    resetActiveTarget();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetTimeSeriesCacheForTests();
    resetActiveTarget();
  });

  it("returns redis-timeseries source with points when MODULE LIST advertises timeseries", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListWithTs());
    fr.setResponse("TS.RANGE", [
      [1_780_000_000_000, "100"],
      [1_780_000_060_000, "200"],
      [1_780_000_120_000, "300"],
    ]);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/observability/history?metric=total_keys" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("redis-timeseries");
    expect(body.metric).toBe("total_keys");
    expect(body.reason).toBeNull();
    expect(body.points).toHaveLength(3);
    expect(body.points[0]).toEqual({ t: 1_780_000_000_000, v: 100 });
    expect(typeof body.target_label).toBe("string");
    const range = fr.calls.find((c) => c.command === "TS.RANGE");
    expect(range).toBeDefined();
    expect(range!.args[0]).toBe("obs:metrics:total_keys");
  });

  it("returns unavailable with reason=module-not-loaded when MODULE LIST has no timeseries", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListWithoutTs());
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/observability/history?metric=memory" });
    // memory is invalid; valid is memory_used_bytes
    expect(res.statusCode).toBe(400);

    const res2 = await app.inject({ method: "GET", url: "/observability/history?metric=memory_used_bytes" });
    expect(res2.statusCode).toBe(200);
    const body = res2.json();
    expect(body.source).toBe("unavailable");
    expect(body.points).toEqual([]);
    expect(body.reason).toBe("module-not-loaded");
  });

  it("returns redis-timeseries with reason=no-data-yet when the TS key is empty", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListWithTs());
    fr.setResponse("TS.RANGE", []);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/observability/history?metric=ops_per_sec" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("redis-timeseries");
    expect(body.points).toEqual([]);
    expect(body.reason).toBe("no-data-yet");
  });

  it("re-detects module availability after a target switch", async () => {
    const frA = fakeRedis();
    frA.setResponse("MODULE", moduleListWithoutTs());
    app = await createServer({ redis: frA });
    setActiveTarget({ host: "a", port: 6379, tls: false, db: 0, label: "target-a" });
    const resA = await app.inject({ method: "GET", url: "/observability/history?metric=shard_count" });
    expect(resA.json().source).toBe("unavailable");
    expect(resA.json().target_label).toBe("target-a");

    // Swap to a target where MODULE LIST advertises timeseries. We rebuild the
    // server with a fresh fake so MODULE LIST reflects the new target's
    // module set; the detection cache is keyed by target_label so the swap
    // alone forces a re-MODULE-LIST.
    await app.close();
    const frB = fakeRedis();
    frB.setResponse("MODULE", moduleListWithTs());
    frB.setResponse("TS.RANGE", [[Date.now(), "42"]]);
    app = await createServer({ redis: frB });
    setActiveTarget({ host: "b", port: 6379, tls: false, db: 0, label: "target-b" });
    const resB = await app.inject({ method: "GET", url: "/observability/history?metric=shard_count" });
    expect(resB.json().source).toBe("redis-timeseries");
    expect(resB.json().target_label).toBe("target-b");
    expect(resB.json().points.length).toBeGreaterThan(0);
  });

  it("does not break /observability/keys when TS.ADD throws", async () => {
    const fr = fakeRedis();
    fr.setDbsize(7);
    fr.setScan("0", ["sens:a", "sens:b"]);
    fr.setResponse("MODULE", moduleListWithTs());
    fr.setResponse("TS.CREATE", "OK");
    fr.setResponse("TS.ADD", () => {
      throw new Error("TS.ADD intentional test failure");
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/observability/keys" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dbsize).toBe(7);
    // Wait a microtask cycle so the fire-and-forget write resolves.
    await new Promise((r) => setImmediate(r));
    // TS.ADD must have been attempted (best-effort write path).
    const tsAdd = fr.calls.find((c) => c.command === "TS.ADD");
    expect(tsAdd).toBeDefined();
  });

  it("rejects invalid metric names with 400", async () => {
    const fr = fakeRedis();
    fr.setResponse("MODULE", moduleListWithTs());
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/observability/history?metric=not_a_metric" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid metric/);
  });
});
