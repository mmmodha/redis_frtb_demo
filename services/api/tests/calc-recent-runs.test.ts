// Wave 6.01 — ring buffer + GET /calc/recent route + active-target clear +
// cache-hit recording. Covers the locked DoD acceptance criteria 1-5.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";
import {
  __resetRecentRunsForTests,
  listRecentRuns,
  pushRecentRun,
  RECENT_RUNS_CAPACITY,
} from "../src/calc/recent-runs.ts";
import { __resetCalcCacheForTests, CALC_DATA_VERSION_KEY } from "../src/sbm/calc-cache.ts";
import { resetActiveTarget, setActiveTarget } from "../src/active-target.ts";

function ftAggregateReply(buckets: string[]): unknown[] {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}

function primeFakeRedis(fr: FakeRedis): void {
  fr.setResponse("GET", (args: unknown[]) => {
    return args[0] === CALC_DATA_VERSION_KEY ? null : null;
  });
  fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
  fr.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "1", "ms", "1"]);
}

describe("Wave 6.01 — recent-runs ring buffer", () => {
  beforeEach(() => {
    __resetRecentRunsForTests();
  });

  it("push-newest-front: most recent push lives at index 0", () => {
    pushRecentRun({
      kind: "per_class", risk_class: "GIRR", leg: "delta",
      charge: 1, total_ms: 1, fanout_ms: 0, cells_evaluated: 1,
      cache: "miss", engine: "fast",
    });
    pushRecentRun({
      kind: "per_class", risk_class: "EQUITY", leg: "vega",
      charge: 2, total_ms: 2, fanout_ms: 0, cells_evaluated: 1,
      cache: "miss", engine: "fast",
    });
    const items = listRecentRuns(5);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ risk_class: "EQUITY", leg: "vega" });
    expect(items[1]).toMatchObject({ risk_class: "GIRR", leg: "delta" });
  });

  it("caps at CAPACITY (20) and keeps the most recent on overflow", () => {
    for (let i = 0; i < RECENT_RUNS_CAPACITY + 1; i += 1) {
      pushRecentRun({
        kind: "per_class", risk_class: "GIRR", leg: "delta",
        charge: i, total_ms: 0, fanout_ms: 0, cells_evaluated: 0,
        cache: "miss", engine: "fast",
      });
    }
    const items = listRecentRuns(50);
    expect(items).toHaveLength(RECENT_RUNS_CAPACITY);
    expect((items[0] as { charge: number }).charge).toBe(RECENT_RUNS_CAPACITY);
    expect((items[items.length - 1] as { charge: number }).charge).toBe(1);
  });

  it("each pushed entry carries an id (ulid) and iso timestamp", () => {
    const entry = pushRecentRun({
      kind: "total", charge: 0, total_ms: 1, cumulative_ms: 2,
      parallelism_factor: 2, redis_ops_count: 27, ops_skipped: 0,
      cells_empty: 0, cache_hits: 0, cache: "miss", engine: "orchestrator",
    });
    expect(entry.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(() => new Date(entry.ts).toISOString()).not.toThrow();
  });
});

describe("Wave 6.01 — GET /calc/recent route", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetRecentRunsForTests();
    __resetCalcCacheForTests();
  });
  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
  });

  it("returns empty items when no runs have been recorded", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({ redis: fr, correlations: {} });
    const res = await app.inject({ method: "GET", url: "/calc/recent" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it("default limit is 5; explicit limit clamps to 1..20", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({ redis: fr, correlations: {} });
    for (let i = 0; i < 25; i += 1) {
      pushRecentRun({
        kind: "per_class", risk_class: "GIRR", leg: "delta",
        charge: i, total_ms: 0, fanout_ms: 0, cells_evaluated: 0,
        cache: "miss", engine: "fast",
      });
    }
    const def = await app.inject({ method: "GET", url: "/calc/recent" });
    expect(def.json().items).toHaveLength(5);
    const ten = await app.inject({ method: "GET", url: "/calc/recent?limit=10" });
    expect(ten.json().items).toHaveLength(10);
    const tooMany = await app.inject({ method: "GET", url: "/calc/recent?limit=99" });
    expect(tooMany.json().items).toHaveLength(20);
    const bad = await app.inject({ method: "GET", url: "/calc/recent?limit=foo" });
    expect(bad.json().items).toHaveLength(5);
  });

  it("after one /calc/sbm success records a per_class entry with cache=miss", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const post = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(post.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/calc/recent?limit=5" });
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "per_class", risk_class: "GIRR", leg: "delta", cache: "miss",
    });
    expect(typeof items[0]!.charge).toBe("number");
    expect(typeof items[0]!.total_ms).toBe("number");
  });

  it("identical body within TTL records the second run as cache=hit", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const payload = { risk_class: "GIRR", sensitivity_type: "Delta" };
    await app.inject({ method: "POST", url: "/calc/sbm", payload });
    await app.inject({ method: "POST", url: "/calc/sbm", payload });
    const list = await app.inject({ method: "GET", url: "/calc/recent?limit=5" });
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]!.cache).toBe("hit");
    expect(items[1]!.cache).toBe("miss");
  });

  it("active-target change clears the buffer", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect((await app.inject({ method: "GET", url: "/calc/recent" })).json().items).toHaveLength(1);
    setActiveTarget({ host: "other", port: 6379, tls: false, db: 0, label: "other" });
    const after = await app.inject({ method: "GET", url: "/calc/recent" });
    expect(after.json()).toEqual({ items: [] });
  });
});
