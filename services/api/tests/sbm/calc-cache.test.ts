// Wave 5.83C-2 — Short-TTL response cache on /calc/sbm.
//
// Covers the four DoD scenarios end-to-end through the Fastify route:
//   1. Identical body → second call returns cache: "hit" with cached_at_iso.
//   2. After POST /admin/flush, data version bumps; next /calc/sbm misses.
//   3. After TTL expiry (advance fake timers past 30 s), next call misses.
//   4. Distinct bodies share no entries — verified by per-body hit/miss.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer } from "../../src/server.ts";
import { fakeRedis, type FakeRedis } from "../helpers/fake-redis.ts";
import {
  __resetCalcCacheForTests,
  CALC_CACHE_TTL_MS,
  CALC_DATA_VERSION_KEY,
} from "../../src/sbm/calc-cache.ts";
import { resetActiveTarget } from "../../src/active-target.ts";

function ftAggregateReply(buckets: string[]): unknown[] {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}

function primeFakeRedis(fr: FakeRedis, version = 0): void {
  // GET / INCR for the data-version stamp. version=0 → key missing (nil).
  fr.setResponse("GET", (args: unknown[]) => {
    return args[0] === CALC_DATA_VERSION_KEY && version > 0 ? String(version) : null;
  });
  let counter = version;
  fr.setResponse("INCR", (args: unknown[]) => {
    if (args[0] === CALC_DATA_VERSION_KEY) {
      counter += 1;
      return counter;
    }
    return 0;
  });
  fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
  fr.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "1", "ms", "1"]);
}

describe("Wave 5.83C-2 — /calc/sbm response cache", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    __resetCalcCacheForTests();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
    vi.restoreAllMocks();
  });

  it("first call returns cache:'miss', repeat with identical body returns cache:'hit' + cached_at_iso", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const payload = { risk_class: "GIRR", sensitivity_type: "Delta" };
    const r1 = await app.inject({ method: "POST", url: "/calc/sbm", payload });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.cache).toBe("miss");
    expect(b1.cached_at_iso).toBeUndefined();

    const fcallsBefore = fr.calls.filter((c) => c.command === "FCALL").length;
    const aggBefore = fr.calls.filter((c) => c.command === "FT.AGGREGATE").length;

    const r2 = await app.inject({ method: "POST", url: "/calc/sbm", payload });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();
    expect(b2.cache).toBe("hit");
    expect(typeof b2.cached_at_iso).toBe("string");
    expect(() => new Date(b2.cached_at_iso).toISOString()).not.toThrow();
    // Hit must not re-issue the underlying redis work.
    expect(fr.calls.filter((c) => c.command === "FCALL").length).toBe(fcallsBefore);
    expect(fr.calls.filter((c) => c.command === "FT.AGGREGATE").length).toBe(aggBefore);
    // Charge / per_bucket carried over from the cached miss body.
    expect(b2.charge).toBeCloseTo(b1.charge, 10);
    expect(b2.per_bucket).toEqual(b1.per_bucket);
  });

  it("distinct request bodies do not share cache entries", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const r1 = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(r1.json().cache).toBe("miss");

    // Different sensitivity_type → different normalised body → miss.
    const r2 = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Vega" },
    });
    expect(r2.json().cache).toBe("miss");

    // Different correlation_regime → miss.
    const r3 = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta", correlation_regime: "high" },
    });
    expect(r3.json().cache).toBe("miss");
  });

  it("POST /admin/flush bumps calc:data_version and the next /calc/sbm misses", async () => {
    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({
      redis: fr,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" },
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const payload = { risk_class: "GIRR", sensitivity_type: "Delta" };
    expect((await app.inject({ method: "POST", url: "/calc/sbm", payload })).json().cache).toBe("miss");
    expect((await app.inject({ method: "POST", url: "/calc/sbm", payload })).json().cache).toBe("hit");

    const flush = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(flush.statusCode).toBe(200);
    // INCR on calc:data_version landed exactly once during the flush.
    const incrs = fr.calls.filter(
      (c) => c.command === "INCR" && c.args[0] === CALC_DATA_VERSION_KEY,
    );
    expect(incrs).toHaveLength(1);

    // Cache was cleared by the bump → next identical call misses.
    expect((await app.inject({ method: "POST", url: "/calc/sbm", payload })).json().cache).toBe("miss");
    // And the new entry is hot again on the call after that.
    expect((await app.inject({ method: "POST", url: "/calc/sbm", payload })).json().cache).toBe("hit");
  });

  it("entries are evicted after the 30s TTL", async () => {
    // vi.useFakeTimers breaks Fastify's internal scheduling — mock only
    // Date.now (which both the cache TTL check and `new Date().toISOString()`
    // route through) so request handling stays on real microtasks/timers.
    let now = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const fr = fakeRedis();
    primeFakeRedis(fr);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const payload = { risk_class: "GIRR", sensitivity_type: "Delta" };
    expect((await app.inject({ method: "POST", url: "/calc/sbm", payload })).json().cache).toBe("miss");
    // Within TTL → hit.
    now += CALC_CACHE_TTL_MS - 1;
    expect((await app.inject({ method: "POST", url: "/calc/sbm", payload })).json().cache).toBe("hit");
    // Cross TTL boundary → miss.
    now += 2;
    expect((await app.inject({ method: "POST", url: "/calc/sbm", payload })).json().cache).toBe("miss");
  });
});
