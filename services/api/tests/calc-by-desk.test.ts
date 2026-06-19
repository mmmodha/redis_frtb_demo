// Wave 6.41.B — POST /calc/sbm/by-desk single-FT.AGGREGATE GROUPBY @desk.
//
// Exercises the route against a fakeRedis that returns a canned FT.AGGREGATE
// reply keyed by @desk. The fixture is shaped like the per-leg reducer aliases
// emitted by buildByDeskAggregateArgs (sum_<ws-field>_safe, sum_<ws-field>_sq,
// row_count) so the route's TS-side K_b reducer consumes the same wire shape
// the live RediSearch GROUPBY would emit.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { resetActiveTarget } from "../src/active-target.ts";

// Minimal Equity-only schema fixture: scalar ws_equity_delta NUMERIC field,
// constant intra-bucket ρ=0 (so K_b reduces to sqrt(ΣWS²) = |ΣWS| on a single
// row, which makes the per-desk K_b directly comparable to the seeded sums).
function equityOnlySchema() {
  return {
    version: 1,
    dimensions: [],
    frtb_binding: {
      risk_class: "risk_class", bucket: "bucket", tenor: "tenor",
      risk_value: "risk_value", weight: "weight", sensitivity_type: "sensitivity_type",
    },
    risk_classes: {
      EQUITY: {
        dimensions: [], buckets: { naming: "bucket", values: ["1"] },
        risk_weights_ref: "eq_w",
        intra_bucket_correlation_ref: "eq_rho",
        cross_bucket_correlation_ref: "eq_gamma",
      },
    },
    risk_weights: { eq_w: { constant: 0.30 } },
    correlations: {
      eq_rho: { kind: "constant", value: 0 },
      eq_gamma: { kind: "constant", value: 0 },
    },
  } as unknown as Parameters<typeof createServer>[0]["schema"];
}

// Build the @desk-keyed reducer row for an Equity Delta by-desk request.
// Mirrors the alias scheme in buildByDeskAggregateArgs: `sum_<f>_safe` for the
// ΣWS reducer, `sum_<f>_sq` for ΣWS².
function deskRowEquityDelta(desk: string, sumWs: number, sumWsSq: number, count: number): unknown[] {
  return [
    "desk", desk,
    "sum_ws_equity_delta_safe", String(sumWs),
    "sum_ws_equity_delta_sq", String(sumWsSq),
    "row_count", String(count),
  ];
}

describe("POST /calc/sbm/by-desk — single FT.AGGREGATE GROUPBY @desk", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  const PREV_FAST = process.env.CALC_FAST_PATH;
  const PREV_GATE = process.env.CALC_ALLOW_FT_AGGREGATE;

  beforeEach(() => {
    process.env.CALC_FAST_PATH = "1";
    process.env.CALC_ALLOW_FT_AGGREGATE = "true";
  });

  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
    if (PREV_FAST === undefined) delete process.env.CALC_FAST_PATH;
    else process.env.CALC_FAST_PATH = PREV_FAST;
    if (PREV_GATE === undefined) delete process.env.CALC_ALLOW_FT_AGGREGATE;
    else process.env.CALC_ALLOW_FT_AGGREGATE = PREV_GATE;
  });

  it("returns desks sorted by |K_b| desc with contribution_pct and total_K_b", async () => {
    const fr = fakeRedis();
    fr.setResponse("GET", () => null);
    fr.setResponse("FT.AGGREGATE", () => [
      3,
      deskRowEquityDelta("RATES_LDN", 10, 100, 100),
      deskRowEquityDelta("EQ_NYC", 5, 25, 50),
      deskRowEquityDelta("FX_HKG", 2, 4, 20),
    ]);
    app = await createServer({ redis: fr, schema: equityOnlySchema() });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/by-desk",
      payload: { risk_class: "EQUITY", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // K_b under ρ=0 collapses to sqrt(ΣWS²) — 10, 5, 2 for the three rows.
    expect(body.desks).toHaveLength(3);
    expect(body.desks[0]).toMatchObject({ desk: "RATES_LDN", K_b: 10, count: 100 });
    expect(body.desks[1]).toMatchObject({ desk: "EQ_NYC", K_b: 5, count: 50 });
    expect(body.desks[2]).toMatchObject({ desk: "FX_HKG", K_b: 2, count: 20 });
    expect(body.total_K_b).toBeCloseTo(17, 10);
    expect(body.desks[0].contribution_pct).toBeCloseTo(58.82, 1);
    expect(body.cached).toBe(false);
    expect(body.ms).toBeGreaterThanOrEqual(0);
  });

  it("dispatches exactly ONE FT.AGGREGATE per request (no per-desk fanout)", async () => {
    const fr = fakeRedis();
    fr.setResponse("GET", () => null);
    fr.setResponse("FT.AGGREGATE", () => [1, deskRowEquityDelta("RATES_LDN", 3, 9, 10)]);
    app = await createServer({ redis: fr, schema: equityOnlySchema() });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/by-desk",
      payload: { risk_class: "EQUITY", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const aggCalls = fr.calls.filter((c) => c.command === "FT.AGGREGATE");
    expect(aggCalls).toHaveLength(1);
    // GROUPBY @desk is in the argv (one slot for the group key count "1" then "@desk").
    const argv = aggCalls[0]!.args.map(String);
    const gbIdx = argv.indexOf("GROUPBY");
    expect(gbIdx).toBeGreaterThanOrEqual(0);
    expect(argv[gbIdx + 1]).toBe("1");
    expect(argv[gbIdx + 2]).toBe("@desk");
  });

  it("include.desk pushes a @desk:{…} predicate into the FT.AGGREGATE query", async () => {
    const fr = fakeRedis();
    fr.setResponse("GET", () => null);
    fr.setResponse("FT.AGGREGATE", () => [1, deskRowEquityDelta("RATES_LDN", 4, 16, 40)]);
    app = await createServer({ redis: fr, schema: equityOnlySchema() });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/by-desk",
      payload: {
        risk_class: "EQUITY",
        sensitivity_type: "Delta",
        include: { desk: ["RATES_LDN"] },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.desks).toHaveLength(1);
    expect(body.desks[0]).toMatchObject({ desk: "RATES_LDN", K_b: 4 });
    const aggCalls = fr.calls.filter((c) => c.command === "FT.AGGREGATE");
    const query = String(aggCalls[0]!.args[1]);
    expect(query).toContain("@desk:{RATES_LDN}");
  });

  it("top_n caps the response and rejects out-of-range values", async () => {
    const fr = fakeRedis();
    fr.setResponse("GET", () => null);
    fr.setResponse("FT.AGGREGATE", () => [
      3,
      deskRowEquityDelta("A", 9, 81, 1),
      deskRowEquityDelta("B", 6, 36, 1),
      deskRowEquityDelta("C", 3, 9, 1),
    ]);
    app = await createServer({ redis: fr, schema: equityOnlySchema() });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/by-desk",
      payload: { risk_class: "EQUITY", sensitivity_type: "Delta", top_n: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.desks).toHaveLength(2);
    expect(body.desks.map((d: { desk: string }) => d.desk)).toEqual(["A", "B"]);

    const over = await app.inject({
      method: "POST",
      url: "/calc/sbm/by-desk",
      payload: { risk_class: "EQUITY", sensitivity_type: "Delta", top_n: 51 },
    });
    expect(over.statusCode).toBe(400);
  });

  it("rejects bad body shapes", async () => {
    const fr = fakeRedis();
    fr.setResponse("GET", () => null);
    fr.setResponse("FT.AGGREGATE", () => [0]);
    app = await createServer({ redis: fr, schema: equityOnlySchema() });

    const missingFields = await app.inject({
      method: "POST", url: "/calc/sbm/by-desk", payload: { risk_class: "EQUITY" },
    });
    expect(missingFields.statusCode).toBe(400);

    const badLeg = await app.inject({
      method: "POST", url: "/calc/sbm/by-desk",
      payload: { risk_class: "EQUITY", sensitivity_type: "Bogus" },
    });
    expect(badLeg.statusCode).toBe(400);

    const badInclude = await app.inject({
      method: "POST", url: "/calc/sbm/by-desk",
      payload: { risk_class: "EQUITY", sensitivity_type: "Delta", include: { desk: "RATES_LDN" } },
    });
    expect(badInclude.statusCode).toBe(400);
  });
});
