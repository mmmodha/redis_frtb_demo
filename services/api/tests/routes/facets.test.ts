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
// Wave 6.18g — /facets no longer uses WITHCURSOR, so replies come back as the
// raw aggregate payload (no [result, cursor_id] wrapper).
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
      aggReply([
        { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 10 },
        { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Vega", n: 3 },
        { risk_class: "GIRR", bucket: "EUR-IRS", sensitivity_type: "Delta", n: 4 },
        { risk_class: "CSR_NS", bucket: "1", sensitivity_type: "Delta", n: 5 },
      ]),
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
    // Wave 6.18g — single-shot bounded aggregate (no cursor lifecycle).
    expect(agg!.args).toContain("LIMIT");
    const limitIdx = agg!.args.indexOf("LIMIT");
    expect(agg!.args[limitIdx + 1]).toBe("0");
    // MAX_GROUPS is a numeric string >0; any non-zero positive guards against
    // accidentally degenerating to LIMIT 0 0 (which returns zero rows).
    expect(Number(agg!.args[limitIdx + 2])).toBeGreaterThan(0);
    expect(agg!.args).not.toContain("WITHCURSOR");
  });

  // Wave 6.18g — the single-shot aggregate uses LIMIT 0 MAX_GROUPS as the cap.
  // The bounded cap from the previous cursor-drain logic must be preserved: if
  // Redis returns more rows than MAX_GROUPS (impossible in practice given the
  // LIMIT clause, but we assert the route's own MAX_GROUPS argument is what
  // bounds the response by reading the LIMIT count back from the call args).
  it("passes a LIMIT 0 <MAX_GROUPS> to FT.AGGREGATE so the result set stays bounded", async () => {
    const fr = fakeRedis();
    // Reply with a single row — the assertion is on the LIMIT argument the
    // route SENT, which is the contract with Redis for the cap.
    fr.setResponse(
      "FT.AGGREGATE",
      aggReply([{ risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 1 }]),
    );
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);

    const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
    expect(agg).toBeDefined();
    const limitIdx = agg!.args.indexOf("LIMIT");
    expect(limitIdx).toBeGreaterThan(-1);
    expect(agg!.args[limitIdx + 1]).toBe("0");
    // Cap value is the in-file MAX_GROUPS constant. It must be a positive
    // integer; if it ever silently drifts to 0 or NaN the route would return
    // no rows at all and the UI dropdowns would empty.
    const cap = Number(agg!.args[limitIdx + 2]);
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThanOrEqual(10_000);
  });

  // Wave 6.18g — empty groups must NEVER 500. Distinct from the
  // index-missing case below (which throws); here Redis is healthy but
  // idx:sens has zero matching rows.
  it("returns 200 with the empty-body shape (no 500) when FT.AGGREGATE returns zero groups", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", aggReply([]));
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

  // Wave 6.09 — Redis 8.x surfaces the missing-index condition as
  // "SEARCH_INDEX_NOT_FOUND Index not found: …". /facets must keep returning
  // the empty-index 200 shape (not 412/500) so the UI doesn't trip on a
  // bootstrapping Redis 8 cluster.
  it("returns ok=false reason='empty-index' (200) on Redis 8 'SEARCH_INDEX_NOT_FOUND Index not found' error", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", () => {
      throw new Error("SEARCH_INDEX_NOT_FOUND Index not found: idx:sens");
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty-index");
    expect(body.total_rows).toBe(0);
  });

  it("returns ok=false reason='empty-index' (200) when the index exists but is empty (0 groups)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", aggReply([]));
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
    // Wave 6.18g — cursor lifecycle is gone; no FT.CURSOR commands at all.
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
      aggReply([{ risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 10 }]),
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
      aggReply([{ risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", n: 1 }]),
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
      aggReply([{ risk_class: "FX", bucket: "USD", sensitivity_type: "Delta", n: 7 }]),
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
      aggReply([{ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Vega", n: 3 }]),
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
