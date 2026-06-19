import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { regionFromDesk, UNKNOWN_REGION } from "@frtb/calc-shared/region";
import { buildFastPathQuery } from "../src/sbm/aggregate-via-index.ts";
import {
  getKbCacheMetrics,
  __resetKbCacheMetricsForTests,
} from "../src/sbm/kb-cache.ts";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { __resetFacetsCacheForTests } from "../src/routes/facets.ts";
import { __resetCalcCacheForTests } from "../src/sbm/calc-cache.ts";

// Wave 6.41.A — include filter + exclude.desk/region/bucket + /facets/desk,
// /facets/region, /facets/bucket. The desk filter and facets endpoints use
// FT.AGGREGATE GROUPBY against `idx:sens` (no ingest writer changes —
// the @desk TAG is already part of the index schema). Region is derived
// from the desk on the fly via shared/calc/src/region.ts.

describe("Wave 6.41.A — regionFromDesk helper", () => {
  it("parses [CLASS]_[REGION] desks correctly", () => {
    expect(regionFromDesk("RATES_LDN")).toBe("LDN");
    expect(regionFromDesk("EQ_NYC")).toBe("NYC");
    expect(regionFromDesk("CREDIT_HKG")).toBe("HKG");
  });
  it("returns UNKNOWN for empty / malformed desks", () => {
    expect(regionFromDesk("")).toBe(UNKNOWN_REGION);
    expect(regionFromDesk(null)).toBe(UNKNOWN_REGION);
    expect(regionFromDesk(undefined)).toBe(UNKNOWN_REGION);
    expect(regionFromDesk("NOUNDERSCORE")).toBe(UNKNOWN_REGION);
    expect(regionFromDesk("TRAILING_")).toBe(UNKNOWN_REGION);
  });
  it("keeps multi-segment regions intact (everything after the first underscore)", () => {
    expect(regionFromDesk("RATES_LDN_EQUITIES")).toBe("LDN_EQUITIES");
  });
});

describe("Wave 6.41.A — buildFastPathQuery pushdown", () => {
  it("emits @desk:{X|Y} for include.desk", () => {
    const q = buildFastPathQuery("GIRR", "Delta", {
      include: { desk: ["RATES_LDN", "RATES_NYC"] },
    });
    expect(q).toContain("@desk:{RATES_LDN|RATES_NYC}");
  });
  it("emits -@desk:{X|Y} for exclude.desk", () => {
    const q = buildFastPathQuery("GIRR", "Delta", {
      exclude: { desk: ["RATES_HKG"] },
    });
    expect(q).toContain("-@desk:{RATES_HKG}");
  });
  it("emits @bucket:{X|Y} for include.bucket alongside bucketSubset", () => {
    const q = buildFastPathQuery("GIRR", "Delta", {
      include: { bucket: ["USD", "EUR"] },
    });
    expect(q).toContain("@bucket:{USD|EUR}");
  });
  it("emits -@bucket:{X|Y} for exclude.bucket", () => {
    const q = buildFastPathQuery("GIRR", "Delta", {
      exclude: { bucket: ["JPY"] },
    });
    expect(q).toContain("-@bucket:{JPY}");
  });
  it("combines include + exclude into a single AND-joined query string", () => {
    const q = buildFastPathQuery("GIRR", "Delta", {
      include: { book: ["B1"], desk: ["RATES_LDN"] },
      exclude: { trade_id: ["T0042"], desk: ["RATES_HKG"] },
    });
    expect(q).toContain("@book:{B1}");
    expect(q).toContain("@desk:{RATES_LDN}");
    expect(q).toContain("-@trade_id:{T0042}");
    expect(q).toContain("-@desk:{RATES_HKG}");
  });
});

function ftAggregateReply(buckets: string[]) {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}

describe("Wave 6.41.A — POST /calc/sbm include + exclude.desk validation", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetCalcCacheForTests();
    __resetKbCacheMetricsForTests();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("rejects include.desk with non-array value (400)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: {
        risk_class: "GIRR", sensitivity_type: "Delta",
        include: { desk: "not-an-array" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/include\.desk/);
  });

  it("accepts include.desk array and de-duplicates", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: {
        risk_class: "GIRR", sensitivity_type: "Delta",
        include: { desk: ["RATES_LDN", "RATES_LDN", "RATES_NYC"] },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts exclude.desk array (Wave 6.41.A symmetry)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: {
        risk_class: "GIRR", sensitivity_type: "Delta",
        exclude: { desk: ["RATES_HKG"] },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 413 when include.desk exceeds the per-list cap", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const tooMany = new Array(1001).fill(0).map((_, i) => `D${i}`);
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: {
        risk_class: "GIRR", sensitivity_type: "Delta",
        include: { desk: tooMany },
      },
    });
    expect(res.statusCode).toBe(413);
  });

  it("rejects include.desk values containing commas (CSV delimiter clash)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: {
        risk_class: "GIRR", sensitivity_type: "Delta",
        include: { desk: ["A,B"] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/commas/);
  });

  it("rejects include with non-object payload (400)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta", include: ["not", "an", "object"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/object/);
  });
});

describe("Wave 6.41.A — kb_cache_skip_filtered_total counter", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let savedFlag: string | undefined;

  beforeEach(() => {
    __resetCalcCacheForTests();
    __resetKbCacheMetricsForTests();
    savedFlag = process.env.CALC_FAST_PATH;
    process.env.CALC_FAST_PATH = "1";
  });
  afterEach(async () => {
    if (app) await app.close();
    if (savedFlag === undefined) delete process.env.CALC_FAST_PATH;
    else process.env.CALC_FAST_PATH = savedFlag;
  });

  function fastPathSchema() {
    return {
      version: 1,
      dimensions: [],
      frtb_binding: {
        risk_class: "risk_class", bucket: "bucket", tenor: "tenor",
        risk_value: "risk_value", weight: "weight", sensitivity_type: "sensitivity_type",
      },
      risk_classes: {
        GIRR: {
          dimensions: [], buckets: { naming: "currency", values: ["USD"] },
          tenor: { count: 1, nodes: ["3M"] },
          risk_weights_ref: "girr_delta_weights",
          intra_bucket_correlation_ref: "girr_rho_kl",
          cross_bucket_correlation_ref: "girr_gamma_bc",
        },
      },
      risk_weights: { girr_delta_weights: { by_tenor: { "3M": 0.017 } } },
      correlations: { girr_rho_kl: { kind: "constant", value: 0 }, girr_vega_rho_kl: { kind: "constant", value: 0 } },
    } as unknown as Parameters<typeof createServer>[0]["schema"];
  }

  it("filtered request bumps kb_cache_skip_filtered_total by the bucket count", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
      // Discovery FT.AGGREGATE (legacy bucket-discovery fixture) and main
      // fast-path FT.AGGREGATE share this responder; the discovery branch
      // is handled by the auto-SMEMBERS shim in fakeRedis.
      const query = String(args[1] ?? "");
      if (query.includes("@desk:")) {
        return [
          1,
          ["bucket", "USD", "row_count", "1", "sum_d_ws_girr_delta_3M", "1", "sum_d_ws_girr_delta_3M_sq", "1"],
        ];
      }
      return ftAggregateReply(["USD"]);
    });
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
      schema: fastPathSchema(),
    });
    const before = getKbCacheMetrics().skip_filtered;
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: {
        risk_class: "GIRR", sensitivity_type: "Delta",
        include: { desk: ["RATES_LDN"] },
      },
    });
    expect(res.statusCode).toBe(200);
    const after = getKbCacheMetrics().skip_filtered;
    expect(after).toBeGreaterThan(before);
  });

  it("unfiltered request does NOT bump kb_cache_skip_filtered_total", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD"]));
    // No rollup hashes — falls through to FT.AGGREGATE; same effect on the counter.
    fr.setResponse("HGETALL", () => null);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
      schema: fastPathSchema(),
    });
    const before = getKbCacheMetrics().skip_filtered;
    const res = await app.inject({
      method: "POST", url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    expect(getKbCacheMetrics().skip_filtered).toBe(before);
  });
});

describe("Wave 6.41.A — GET /facets/desk", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetFacetsCacheForTests();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns sorted desk + count list from FT.AGGREGATE GROUPBY @desk", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", [
      3,
      ["desk", "RATES_LDN", "count", "10"],
      ["desk", "RATES_NYC", "count", "5"],
      ["desk", "EQ_HKG", "count", "2"],
    ]);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/facets/desk" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.desks).toEqual([
      { desk: "RATES_LDN", count: 10 },
      { desk: "RATES_NYC", count: 5 },
      { desk: "EQ_HKG", count: 2 },
    ]);
    expect(typeof body.ms).toBe("number");
    expect(typeof body.target_label).toBe("string");
    expect(body.cached).toBe(false);
  });

  it("serves second call from cache without re-issuing FT.AGGREGATE", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", [1, ["desk", "RATES_LDN", "count", "1"]]);
    app = await createServer({ redis: fr });
    const r1 = await app.inject({ method: "GET", url: "/facets/desk" });
    expect(r1.json().cached).toBe(false);
    const fta1 = fr.calls.filter((c) => c.command === "FT.AGGREGATE").length;
    const r2 = await app.inject({ method: "GET", url: "/facets/desk" });
    expect(r2.json().cached).toBe(true);
    const fta2 = fr.calls.filter((c) => c.command === "FT.AGGREGATE").length;
    expect(fta2).toBe(fta1);
  });
});

describe("Wave 6.41.A — GET /facets/region", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetFacetsCacheForTests();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("collapses desks into regions via shared/calc/src/region.ts", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", [
      4,
      ["desk", "RATES_LDN", "count", "10"],
      ["desk", "EQ_LDN", "count", "3"],
      ["desk", "RATES_NYC", "count", "5"],
      ["desk", "NOUNDERSCORE", "count", "1"],
    ]);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/facets/region" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // Sorted by count desc, then alpha — LDN (13) > NYC (5) > UNKNOWN (1)
    expect(body.regions).toEqual([
      { region: "LDN", count: 13 },
      { region: "NYC", count: 5 },
      { region: "UNKNOWN", count: 1 },
    ]);
  });
});

describe("Wave 6.41.A — GET /facets/bucket", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetFacetsCacheForTests();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns (risk_class, bucket, count) triples from FT.AGGREGATE GROUPBY @risk_class @bucket", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", [
      3,
      ["risk_class", "GIRR", "bucket", "USD", "count", "10"],
      ["risk_class", "GIRR", "bucket", "EUR", "count", "5"],
      ["risk_class", "EQUITY", "bucket", "1", "count", "3"],
    ]);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/facets/bucket" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.buckets).toEqual([
      { risk_class: "GIRR", bucket: "USD", count: 10 },
      { risk_class: "GIRR", bucket: "EUR", count: 5 },
      { risk_class: "EQUITY", bucket: "1", count: 3 },
    ]);
    expect(typeof body.ms).toBe("number");
    expect(body.cached).toBe(false);
  });
});
