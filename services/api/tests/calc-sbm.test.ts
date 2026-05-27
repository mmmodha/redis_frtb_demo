import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

// FT.AGGREGATE reply for GROUPBY @bucket → returns ["total", "@bucket", "USD-IRS", "@bucket", "EUR-IRS", ...]
// Per Redis docs, FT.AGGREGATE returns [total, ...replies]
function ftAggregateReply(buckets: string[]) {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}

describe("POST /calc/sbm — MVP endpoint", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("orchestrates discover→fanout→reduce for GIRR Delta and returns locked-contract shape", async () => {
    const fr = fakeRedis();
    // Step 1: discover buckets via FT.AGGREGATE GROUPBY @bucket
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS", "EUR-IRS"]));
    // Step 2: FCALL fan-out — return { K_b, S_b, count, ms } per bucket.
    // Returned as RESP map (flat key/value array) so the handler can parse either shape.
    fr.setResponse("FCALL", (args: unknown[]) => {
      // args: [funcName, numkeys, key, risk_class, bucket]
      const bucket = args[4] as string;
      if (bucket === "USD-IRS") {
        return ["K_b", "3", "S_b", "3", "count", "100", "ms", "5"];
      }
      return ["K_b", "4", "S_b", "4", "count", "200", "ms", "6"];
    });

    app = await createServer({
      redis: fr,
      // inline schema so we don't need the YAML on disk during the unit test
      correlations: {
        GIRR: { kind: "constant", value: 0 }, // γ=0 → charge = √(9+16) = 5
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.charge).toBeCloseTo(5, 10);
    expect(body.per_bucket).toHaveLength(2);
    const sorted = body.per_bucket.slice().sort((a: any, b: any) => a.bucket.localeCompare(b.bucket));
    expect(sorted[0]).toMatchObject({ bucket: "EUR-IRS", K_b: 4, S_b: 4, count: 200, ms: 6 });
    expect(sorted[1]).toMatchObject({ bucket: "USD-IRS", K_b: 3, S_b: 3, count: 100, ms: 5 });
    expect(body.total_ms).toBeGreaterThanOrEqual(0);
    expect(body.shard_breakdown).toBeDefined();
    expect(Array.isArray(body.shard_breakdown)).toBe(true);

    // Verify FCALL was issued per bucket with the locked routing-key hash-tag pattern
    const fcalls = fr.calls.filter((c) => c.command === "FCALL");
    expect(fcalls).toHaveLength(2);
    for (const c of fcalls) {
      expect(c.args[0]).toBe("frtb.sbm_delta_bucket");
      expect(c.args[1]).toBe("1"); // numkeys
      const key = String(c.args[2]);
      expect(key).toMatch(/^sens:\{GIRR:[^}]+\}:_route$/);
      expect(c.args[3]).toBe("GIRR");
    }
    // discover query was for the requested risk_class
    const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
    expect(agg).toBeDefined();
    expect(agg!.args[0]).toBe("idx:sens");
    expect(String(agg!.args[1])).toContain("@risk_class:{GIRR}");
    expect(agg!.args).toContain("GROUPBY");
  });

  it("Vega routes to frtb.sbm_vega_bucket and accepts case-insensitive sensitivity_type", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["1"]));
    fr.setResponse("FCALL", ["K_b", "2", "S_b", "2", "count", "10", "ms", "1"]);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "VEGA" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().charge).toBeCloseTo(2, 10);
    const fc = fr.calls.find((c) => c.command === "FCALL");
    expect(fc!.args[0]).toBe("frtb.sbm_vega_bucket");
  });

  it("Equity routes Delta to frtb.equity_delta and Vega to frtb.equity_vega", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["1"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "5", "ms", "1"]);
    app = await createServer({
      redis: fr,
      correlations: { Equity: { kind: "constant", value: 0 } },
    });
    const delta = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "Equity", sensitivity_type: "Delta" },
    });
    expect(delta.statusCode).toBe(200);
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("frtb.equity_delta");

    fr.calls.length = 0;
    const vega = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "Equity", sensitivity_type: "Vega" },
    });
    expect(vega.statusCode).toBe(200);
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("frtb.equity_vega");
  });

  it("FX routes Delta to frtb.fx_delta and Vega to frtb.fx_vega", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["EURUSD"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "3", "ms", "1"]);
    app = await createServer({
      redis: fr,
      correlations: { FX: { kind: "constant", value: 0 } },
    });
    const delta = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "FX", sensitivity_type: "Delta" },
    });
    expect(delta.statusCode).toBe(200);
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("frtb.fx_delta");

    fr.calls.length = 0;
    const vega = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "FX", sensitivity_type: "Vega" },
    });
    expect(vega.statusCode).toBe(200);
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("frtb.fx_vega");
  });

  it("returns 400 on missing risk_class or invalid sensitivity_type", async () => {
    app = await createServer({ redis: fakeRedis() });
    const a = await app.inject({ method: "POST", url: "/calc/sbm", payload: {} });
    expect(a.statusCode).toBe(400);
    const b = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Curvature" },
    });
    expect(b.statusCode).toBe(400);
  });

  // Wave 5.8.4: a 200 with charge=0 on a portfolio that has no rows (or no
  // idx:sens on some shards) silently masks a precondition failure. The route
  // must hard-fail with a diagnostic 503 when the discover step finds no
  // buckets AND a follow-up FT.SEARCH confirms zero matching rows.
  it("returns 503 no-data-or-index when FT.AGGREGATE is empty AND FT.SEARCH finds zero rows", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    // FT.SEARCH ... LIMIT 0 0 returns [totalMatches] when no rows match.
    fr.setResponse("FT.SEARCH", [0]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body).toMatchObject({
      error: "no-data-or-index",
      risk_class: "GIRR",
      measure: "delta",
    });
    expect(typeof body.hint).toBe("string");
    expect(body.hint.length).toBeGreaterThan(0);

    // Verify the precondition probe was issued against the same risk_class
    // filter as the discover step.
    const search = fr.calls.find((c) => c.command === "FT.SEARCH");
    expect(search).toBeDefined();
    expect(search!.args[0]).toBe("idx:sens");
    expect(String(search!.args[1])).toContain("@risk_class:{GIRR}");
    // FCALL must NOT be issued when the precondition failed.
    expect(fr.calls.find((c) => c.command === "FCALL")).toBeUndefined();
  });

  it("returns 503 no-data-or-index when FT.SEARCH itself errors (missing index)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    // Simulate `idx:sens` missing on this shard — FT.SEARCH throws.
    fr.setResponse("FT.SEARCH", () => {
      throw new Error("Unknown Index name");
    });
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Vega" },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body).toMatchObject({
      error: "no-data-or-index",
      risk_class: "GIRR",
      measure: "vega",
    });
  });
});
