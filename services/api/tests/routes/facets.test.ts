import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer } from "../../src/server.ts";
import { fakeRedis } from "../helpers/fake-redis.ts";
import { __resetFacetsCacheForTests } from "../../src/routes/facets.ts";
import {
  setActiveTarget,
  setActiveTargetLabel,
  resetActiveTarget,
} from "../../src/active-target.ts";

// FT.AGGREGATE RESP2 shape for GROUPBY ... REDUCE COUNT 0 AS n:
//   [ num_groups, [field, val, field, val, ...], [field, val, ...] ]
function aggReply(rows: Array<Record<string, string | number>>) {
  const out: unknown[] = [rows.length];
  for (const r of rows) {
    const flat: unknown[] = [];
    for (const [k, v] of Object.entries(r)) {
      flat.push(k, String(v));
    }
    out.push(flat);
  }
  return out;
}

// FT.AGGREGATE ... WITHCURSOR / FT.CURSOR READ wrap the aggregate payload as
// [result, cursor_id]. cursor_id === 0 signals the cursor is exhausted.
function cursorReply(rows: Array<Record<string, string | number>>, cursorId: number) {
  return [aggReply(rows), cursorId];
}

describe("GET /facets", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    // Wave 5.67 — the route now caches the body for 30 s keyed by active-
    // target identity. Tests share the default identity (127.0.0.1:6379),
    // so without this reset a body cached by an earlier case would serve
    // the next case before its fake-redis was consulted.
    __resetFacetsCacheForTests();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
    vi.useRealTimers();
  });

  it("aggregates FT.AGGREGATE rows into risk_class / sensitivity_type / bucket_by_risk_class counts", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "FT.AGGREGATE",
      cursorReply(
        [
          { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 10 },
          { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Vega", n: 3 },
          { risk_class: "GIRR", bucket: "EUR-IRS", sensitivity_type: "Delta", n: 4 },
          { risk_class: "CSR_NS", bucket: "1", sensitivity_type: "Delta", n: 5 },
        ],
        0,
      ),
    );
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.total_rows).toBe(22);
    expect(body.risk_class).toEqual({ GIRR: 17, CSR_NS: 5 });
    expect(body.sensitivity_type).toEqual({ Delta: 19, Vega: 3 });
    expect(body.bucket_by_risk_class).toEqual({
      GIRR: { "USD-IRS": 13, "EUR-IRS": 4 },
      CSR_NS: { "1": 5 },
    });
    expect(body.ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.target_label).toBe("string");

    const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
    expect(agg).toBeDefined();
    expect(agg!.args[0]).toBe("idx:sens");
    expect(agg!.args[1]).toBe("*");
    expect(agg!.args).toContain("GROUPBY");
    expect(agg!.args).toContain("@risk_class");
    expect(agg!.args).toContain("@bucket");
    expect(agg!.args).toContain("@sensitivity_type");
    expect(agg!.args).toContain("REDUCE");
    expect(agg!.args).toContain("COUNT");
    expect(agg!.args).toContain("WITHCURSOR");
  });

  it("drains FT.CURSOR READs when FT.AGGREGATE returns the [N]-only bug shape on Redis Search 8", async () => {
    // Search 8 first page: cursor wrapper around just [N] (no rows); all
    // grouped rows arrive on the FT.CURSOR READ that follows.
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", [[0], 42]);
    fr.setResponse("FT.CURSOR", (args) => {
      expect(args[0]).toBe("READ");
      expect(args[1]).toBe("idx:sens");
      expect(args[2]).toBe("42");
      return cursorReply(
        [
          { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 100 },
          { risk_class: "FX", bucket: "USD", sensitivity_type: "Delta", n: 50 },
          { risk_class: "EQUITY", bucket: "1", sensitivity_type: "Vega", n: 7 },
        ],
        0,
      );
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.total_rows).toBe(157);
    expect(body.risk_class).toEqual({ GIRR: 100, FX: 50, EQUITY: 7 });
    expect(body.sensitivity_type).toEqual({ Delta: 150, Vega: 7 });
    expect(body.bucket_by_risk_class).toEqual({
      GIRR: { "USD-IRS": 100 },
      FX: { USD: 50 },
      EQUITY: { "1": 7 },
    });

    // One FT.CURSOR READ, no DEL needed once cursor returned 0.
    const cursorCalls = fr.calls.filter((c) => c.command === "FT.CURSOR");
    expect(cursorCalls.length).toBe(1);
    expect(cursorCalls[0]!.args[0]).toBe("READ");
  });

  it("drains multiple FT.CURSOR READ pages until cursor_id returns 0", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", cursorReply(
      [{ risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", n: 10 }],
      111,
    ));
    let readCount = 0;
    fr.setResponse("FT.CURSOR", (args) => {
      expect(args[0]).toBe("READ");
      readCount += 1;
      if (readCount === 1) {
        expect(args[2]).toBe("111");
        return cursorReply(
          [{ risk_class: "FX", bucket: "EUR", sensitivity_type: "Delta", n: 20 }],
          222,
        );
      }
      expect(args[2]).toBe("222");
      return cursorReply(
        [{ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Vega", n: 30 }],
        0,
      );
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.total_rows).toBe(60);
    expect(body.risk_class).toEqual({ GIRR: 10, FX: 20, EQUITY: 30 });
    expect(body.bucket_by_risk_class).toEqual({
      GIRR: { USD: 10 },
      FX: { EUR: 20 },
      EQUITY: { "1": 30 },
    });

    expect(readCount).toBe(2);
    // No DEL since the final read drained the cursor (returned 0).
    expect(fr.calls.some((c) => c.command === "FT.CURSOR" && c.args[0] === "DEL")).toBe(false);
  });

  it("returns ok=false reason='empty-index' (200) when idx:sens does not exist on the target", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", () => {
      throw new Error("Unknown Index name");
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty-index");
    expect(body.total_rows).toBe(0);
    expect(body.risk_class).toEqual({});
    expect(body.sensitivity_type).toEqual({});
    expect(body.bucket_by_risk_class).toEqual({});
  });

  it("returns ok=false reason='empty-index' (200) when the index exists but is empty (0 groups)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", cursorReply([], 0));
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty-index");
    // No FT.CURSOR calls when the first reply already returns cursor_id=0.
    expect(fr.calls.some((c) => c.command === "FT.CURSOR")).toBe(false);
  });

  it("translates 'Function not found' style errors via translateRedisError (412)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", () => {
      throw new Error("Function not found");
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(412);
    const body = res.json();
    expect(typeof body.error).toBe("string");
    expect(typeof body.target_label).toBe("string");
    expect(typeof body.bootstrap_phase).toBe("string");
  });

  it("re-throws unknown Redis errors as 500", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", () => {
      throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(500);
  });

  // Wave 5.67 — short-TTL (30 s) response cache.

  it("serves the second back-to-back call from cache without calling FT.AGGREGATE", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "FT.AGGREGATE",
      cursorReply(
        [{ risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 10 }],
        0,
      ),
    );
    app = await createServer({ redis: fr });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.ok).toBe(true);
    expect(b1.cached).toBe(false);

    const r2 = await app.inject({ method: "GET", url: "/facets" });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();
    expect(b2.ok).toBe(true);
    expect(b2.cached).toBe(true);
    expect(b2.total_rows).toBe(b1.total_rows);
    expect(b2.risk_class).toEqual(b1.risk_class);

    // Only the first call should have hit FT.AGGREGATE.
    const aggCalls = fr.calls.filter((c) => c.command === "FT.AGGREGATE");
    expect(aggCalls.length).toBe(1);
  });

  it("invalidates the cache when active-target identity changes (cached=false on second call)", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "FT.AGGREGATE",
      cursorReply(
        [{ risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 1 }],
        0,
      ),
    );
    app = await createServer({ redis: fr });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.json().cached).toBe(false);

    // Identity switch — different host/port. onActiveTargetChange fires and
    // clears the cache.
    setActiveTarget({
      host: "other-host",
      port: 6380,
      tls: false,
      db: 0,
      label: "other-cluster",
    });

    const r2 = await app.inject({ method: "GET", url: "/facets" });
    const b2 = r2.json();
    expect(b2.ok).toBe(true);
    expect(b2.cached).toBe(false);
    const aggCalls = fr.calls.filter((c) => c.command === "FT.AGGREGATE");
    expect(aggCalls.length).toBe(2);
  });

  it("preserves the cache across a label-only rename of the active target", async () => {
    setActiveTarget({
      host: "h1",
      port: 6379,
      tls: false,
      db: 0,
      label: "original-label",
    });
    // First call after the setActiveTarget above primes the cache; the
    // identity-change listener has already cleared any stale entry.
    const fr = fakeRedis();
    fr.setResponse(
      "FT.AGGREGATE",
      cursorReply(
        [{ risk_class: "FX", bucket: "USD", sensitivity_type: "Delta", n: 7 }],
        0,
      ),
    );
    app = await createServer({ redis: fr });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.json().cached).toBe(false);
    expect(r1.json().target_label).toBe("original-label");

    // Label-only rename — must NOT bump credsGeneration / fire listeners,
    // so the cached body is still valid and returned with cached=true.
    setActiveTargetLabel("renamed-label");

    const r2 = await app.inject({ method: "GET", url: "/facets" });
    const b2 = r2.json();
    expect(b2.cached).toBe(true);
    const aggCalls = fr.calls.filter((c) => c.command === "FT.AGGREGATE");
    expect(aggCalls.length).toBe(1);
  });

  it("re-drains FT.AGGREGATE after the 30 s TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T00:00:00Z"));

    const fr = fakeRedis();
    fr.setResponse(
      "FT.AGGREGATE",
      cursorReply(
        [{ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Vega", n: 3 }],
        0,
      ),
    );
    app = await createServer({ redis: fr });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.json().cached).toBe(false);

    // Within TTL — still cached.
    vi.advanceTimersByTime(29_000);
    const r2 = await app.inject({ method: "GET", url: "/facets" });
    expect(r2.json().cached).toBe(true);

    // Past TTL — fresh drain.
    vi.advanceTimersByTime(2_000);
    const r3 = await app.inject({ method: "GET", url: "/facets" });
    expect(r3.json().cached).toBe(false);

    const aggCalls = fr.calls.filter((c) => c.command === "FT.AGGREGATE");
    expect(aggCalls.length).toBe(2);
  });
});
