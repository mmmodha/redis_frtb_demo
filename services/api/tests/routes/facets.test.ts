import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { Schema } from "@frtb/schema";
import { rollupKey } from "@frtb/calc-shared/rollup-keys";
import { createServer } from "../../src/server.ts";
import { fakeRedis } from "../helpers/fake-redis.ts";
import { __resetFacetsCacheForTests } from "../../src/routes/facets.ts";
import {
  setActiveTarget,
  setActiveTargetLabel,
  resetActiveTarget,
} from "../../src/active-target.ts";

// Wave 6.28 — /facets now reads pre-aggregated row counts from the rollup
// hashes that ingest (Wave 6.14a) maintains at `rollup:{rc:bkt}:<sens>`. For
// each (risk_class, bucket, sensitivity_type) triple permitted by the schema,
// the route HGETs the `count` field through a non-transactional ioredis
// pipeline and sums in JS. Tests pin a minimal hand-crafted schema so the
// expected fan-out is enumerable; production wires the real schema via
// createServer({schema}) → registerFacetsRoute({schema}).

// Minimal stand-in for the YAML schema. Only the fields the route reads
// (`risk_classes[*].buckets.values`) are populated; the rest is stubbed
// enough to satisfy the Schema type via `as unknown as Schema`.
function fixtureSchema(): Schema {
  return {
    version: 1,
    dimensions: [],
    risk_classes: {
      GIRR: {
        dimensions: [],
        buckets: { naming: "currency", values: ["USD", "EUR"] },
        risk_weights_ref: "rw",
        intra_bucket_correlation_ref: "ibc",
        cross_bucket_correlation_ref: "cbc",
      },
      CSR_NON_SEC: {
        dimensions: [],
        buckets: { naming: "sector", values: ["1", "2"] },
        risk_weights_ref: "rw",
        intra_bucket_correlation_ref: "ibc",
        cross_bucket_correlation_ref: "cbc",
      },
    },
    frtb_binding: {
      risk_class: "risk_class",
      bucket: "bucket",
      tenor: "tenor",
      risk_value: "risk_value",
      weight: "weight",
      sensitivity_type: "sensitivity_type",
    },
    risk_weights: {},
    correlations: {},
  } as unknown as Schema;
}

// Build a fakeRedis HGET responder that returns the canned count for each
// rollup key. HGET against a missing field/hash returns null (matching real
// Redis), so unmapped keys collapse to 0 contributions in the aggregation.
function hgetResponder(counts: Record<string, number>) {
  return (args: unknown[]) => {
    const key = String(args[0]);
    const field = String(args[1]);
    if (field !== "count") return null;
    const v = counts[key];
    return v == null ? null : String(v);
  };
}

describe("GET /facets", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    // Wave 5.67 — the route caches the body for 30 s keyed by active-target
    // identity. Tests share the default identity (127.0.0.1:6379), so without
    // this reset a body cached by an earlier case would serve the next case
    // before its fake-redis was consulted.
    __resetFacetsCacheForTests();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
    vi.useRealTimers();
  });

  it("aggregates rollup HGET counts into risk_class / sensitivity_type / bucket_by_risk_class", async () => {
    // Per-(rc, bk, st) counts engineered to produce the expected groupings:
    //   GIRR USD = 10+3+0 = 13, GIRR EUR = 4+0+0 = 4   → GIRR = 17
    //   CSR_NON_SEC 1 = 5+0+0 = 5, CSR_NON_SEC 2 = 0   → CSR_NON_SEC = 5
    //   Delta = 10+4+5 = 19, Vega = 3+0+0 = 3, Curvature = 0
    //   total_rows = 22
    const fr = fakeRedis();
    fr.setResponse(
      "HGET",
      hgetResponder({
        [rollupKey("GIRR", "USD", "Delta")]: 10,
        [rollupKey("GIRR", "USD", "Vega")]: 3,
        [rollupKey("GIRR", "EUR", "Delta")]: 4,
        [rollupKey("CSR_NON_SEC", "1", "Delta")]: 5,
      }),
    );
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.total_rows).toBe(22);
    expect(body.risk_class).toEqual({ GIRR: 17, CSR_NON_SEC: 5 });
    expect(body.sensitivity_type).toEqual({ Delta: 19, Vega: 3 });
    expect(body.bucket_by_risk_class).toEqual({
      GIRR: { USD: 13, EUR: 4 },
      CSR_NON_SEC: { "1": 5 },
    });
    expect(body.ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.target_label).toBe("string");
  });

  it("issues HGET calls in a single pipeline covering every (risk_class, bucket, sensitivity_type) triple", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "HGET",
      hgetResponder({ [rollupKey("GIRR", "USD", "Delta")]: 1 }),
    );
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);

    const hgets = fr.calls.filter((c) => c.command === "HGET");
    // No FT.SEARCH / FT.AGGREGATE / FT.CURSOR fan-out should remain — the
    // whole point of Wave 6.28 is to keep idx:sens out of the hot path.
    expect(fr.calls.some((c) => c.command === "FT.SEARCH")).toBe(false);
    expect(fr.calls.some((c) => c.command === "FT.AGGREGATE")).toBe(false);
    expect(fr.calls.some((c) => c.command === "FT.CURSOR")).toBe(false);

    // 2 risk_classes × (2+2) buckets × 3 sensitivity_types = 12 HGETs.
    expect(hgets.length).toBe(12);

    // Every HGET targets the canonical rollup key shape and the `count` field.
    const keys = hgets.map((c) => String(c.args[0]));
    for (const c of hgets) {
      expect(c.args[1]).toBe("count");
      expect(String(c.args[0])).toMatch(/^rollup:\{[^:]+:[^}]+\}:[A-Za-z]+$/);
    }
    expect(keys).toContain(rollupKey("GIRR", "USD", "Delta"));
    expect(keys).toContain(rollupKey("GIRR", "USD", "Vega"));
    expect(keys).toContain(rollupKey("GIRR", "USD", "Curvature"));
    expect(keys).toContain(rollupKey("GIRR", "EUR", "Delta"));
    expect(keys).toContain(rollupKey("CSR_NON_SEC", "1", "Delta"));
    expect(keys).toContain(rollupKey("CSR_NON_SEC", "2", "Curvature"));
  });

  // Wave 6.28 — when every rollup HGET returns null (healthy Redis but no
  // ingest has populated the rollups yet) the route returns the empty-body
  // 200 shape rather than a 500.
  it("returns 200 with the empty-body shape when every rollup count is null", async () => {
    const fr = fakeRedis();
    // Use a function returning null rather than `null` directly — the
    // fakeRedis pipeline treats a falsy responder as "no response set"
    // and synthesises an error tuple.
    fr.setResponse("HGET", () => null);
    app = await createServer({ redis: fr, schema: fixtureSchema() });

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

  it("translates 'Function not found' style errors via translateRedisError (412)", async () => {
    const fr = fakeRedis();
    fr.setResponse("HGET", () => {
      throw new Error("Function not found");
    });
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(412);
    const body = res.json();
    expect(typeof body.error).toBe("string");
    expect(typeof body.target_label).toBe("string");
    expect(typeof body.bootstrap_phase).toBe("string");
  });

  it("re-throws unknown Redis errors as 500", async () => {
    const fr = fakeRedis();
    fr.setResponse("HGET", () => {
      throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    });
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(500);
  });

  // Wave 5.67 — short-TTL (30 s) response cache.

  it("serves the second back-to-back call from cache without re-issuing HGET", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "HGET",
      hgetResponder({ [rollupKey("GIRR", "USD", "Delta")]: 10 }),
    );
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.ok).toBe(true);
    expect(b1.cached).toBe(false);
    const firstCallCount = fr.calls.filter((c) => c.command === "HGET").length;

    const r2 = await app.inject({ method: "GET", url: "/facets" });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();
    expect(b2.ok).toBe(true);
    expect(b2.cached).toBe(true);
    expect(b2.total_rows).toBe(b1.total_rows);
    expect(b2.risk_class).toEqual(b1.risk_class);

    // Second call must not have added any HGET calls.
    const totalCallCount = fr.calls.filter((c) => c.command === "HGET").length;
    expect(totalCallCount).toBe(firstCallCount);
  });

  it("invalidates the cache when active-target identity changes (cached=false on second call)", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "HGET",
      hgetResponder({ [rollupKey("GIRR", "USD", "Delta")]: 1 }),
    );
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.json().cached).toBe(false);
    const after1 = fr.calls.filter((c) => c.command === "HGET").length;

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
    const after2 = fr.calls.filter((c) => c.command === "HGET").length;
    // A second fan-out must have happened.
    expect(after2).toBeGreaterThan(after1);
  });

  it("preserves the cache across a label-only rename of the active target", async () => {
    setActiveTarget({
      host: "h1",
      port: 6379,
      tls: false,
      db: 0,
      label: "original-label",
    });
    const fr = fakeRedis();
    fr.setResponse(
      "HGET",
      hgetResponder({ [rollupKey("GIRR", "USD", "Delta")]: 7 }),
    );
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.json().cached).toBe(false);
    expect(r1.json().target_label).toBe("original-label");
    const after1 = fr.calls.filter((c) => c.command === "HGET").length;

    // Label-only rename — must NOT bump credsGeneration / fire listeners,
    // so the cached body is still valid and returned with cached=true.
    setActiveTargetLabel("renamed-label");

    const r2 = await app.inject({ method: "GET", url: "/facets" });
    const b2 = r2.json();
    expect(b2.cached).toBe(true);
    const after2 = fr.calls.filter((c) => c.command === "HGET").length;
    expect(after2).toBe(after1);
  });

  it("re-issues HGET after the 30 s TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T00:00:00Z"));

    const fr = fakeRedis();
    fr.setResponse(
      "HGET",
      hgetResponder({ [rollupKey("GIRR", "USD", "Delta")]: 3 }),
    );
    app = await createServer({ redis: fr, schema: fixtureSchema() });

    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.json().cached).toBe(false);
    const after1 = fr.calls.filter((c) => c.command === "HGET").length;

    // Within TTL — still cached.
    vi.advanceTimersByTime(29_000);
    const r2 = await app.inject({ method: "GET", url: "/facets" });
    expect(r2.json().cached).toBe(true);
    const after2 = fr.calls.filter((c) => c.command === "HGET").length;
    expect(after2).toBe(after1);

    // Past TTL — fresh fan-out.
    vi.advanceTimersByTime(2_000);
    const r3 = await app.inject({ method: "GET", url: "/facets" });
    expect(r3.json().cached).toBe(false);
    const after3 = fr.calls.filter((c) => c.command === "HGET").length;
    expect(after3).toBeGreaterThan(after2);
  });
});
