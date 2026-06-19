import { describe, it, expect, afterEach } from "vitest";
import type { Schema } from "@frtb/schema";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

// FT.SEARCH reply shape (RESP2 array, what ioredis returns for `client.call`):
//   [ total: number, key1, fields1, key2, fields2, ... ]
// where fields are flat ["field1", "value1", "field2", "value2", ...].
// We use $.<field> JSONPath returning RAW JSON strings via RETURN $.
function ftSearchReply(total: number, rows: Array<{ key: string; doc: object }>) {
  const out: unknown[] = [total];
  for (const r of rows) {
    out.push(r.key);
    out.push(["$", JSON.stringify(r.doc)]);
  }
  return out;
}

describe("GET /pivot", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("issues FT.SEARCH against idx:sens with TAG filters and returns paged rows + ms", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "FT.SEARCH",
      ftSearchReply(2, [
        {
          key: "sens:01HXAA",
          doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", risk_value: [0.1, 0.2] },
        },
        {
          key: "sens:01HXBB",
          doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", risk_value: [0.3] },
        },
      ])
    );
    app = await createServer({ redis: fr });
    const res = await app.inject({
      method: "GET",
      url: "/pivot?risk_class=GIRR&bucket=USD-IRS&sensitivity_type=Delta&limit=50&offset=0",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.ms).toBeGreaterThanOrEqual(0);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].key).toBe("sens:01HXAA");
    expect(body.rows[0].doc.risk_class).toBe("GIRR");
    expect(body.rows[0].doc.risk_value).toEqual([0.1, 0.2]);

    // assert the FT.SEARCH command construction
    const search = fr.calls.find((c) => c.command === "FT.SEARCH");
    expect(search).toBeDefined();
    expect(search!.args[0]).toBe("idx:sens");
    // The query should AND the provided TAG filters
    const query = String(search!.args[1]);
    expect(query).toContain("@risk_class:{GIRR}");
    expect(query).toContain("@bucket:{USD\\-IRS}");
    expect(query).toContain("@sensitivity_type:{Delta}");
    // LIMIT offset count
    expect(search!.args).toContain("LIMIT");
    expect(search!.args).toContain("DIALECT");
  });

  it("defaults limit=100 and offset=0 when not supplied; query is '*' when no filters", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SEARCH", ftSearchReply(0, []));
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/pivot" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    expect(body.rows).toEqual([]);
    const search = fr.calls.find((c) => c.command === "FT.SEARCH");
    expect(search!.args[1]).toBe("*");
  });

  it("clamps limit to 1000 to protect the api process from huge replies", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SEARCH", ftSearchReply(0, []));
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/pivot?limit=99999" });
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(1000);
  });

  it("returns 400 on negative offset", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/pivot?offset=-1" });
    expect(res.statusCode).toBe(400);
  });

  it("Wave 5.30b — risk_factor filter is escaped and appended to the FT.SEARCH query", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SEARCH", ftSearchReply(0, []));
    app = await createServer({ redis: fr });
    const res = await app.inject({
      method: "GET",
      url: "/pivot?risk_factor=RF_GIRR_05&trade_id=T0042",
    });
    expect(res.statusCode).toBe(200);
    const search = fr.calls.find((c) => c.command === "FT.SEARCH");
    expect(search).toBeDefined();
    const query = String(search!.args[1]);
    expect(query).toContain("@risk_factor:{RF_GIRR_05}");
    expect(query).toContain("@trade_id:{T0042}");
  });

  // Wave 6.47.B — the hash-sidetable storage variant (Wave 6.38.A default)
  // stores only pre-weighted `ws_*` numerics on the parent HASH; raw
  // risk_value lives in `{<parentKey>}:tenors` for per-tenor classes, and
  // `weight` is never persisted at all. /pivot now enriches each returned
  // row in a single pipelined HGETALL round-trip + an in-memory schema
  // lookup so the CalcPanel drilldown table renders concrete values rather
  // than "—" across the board.
  describe("Wave 6.47.B — side-table + schema enrichment", () => {
    function girrOnlySchema(): Schema {
      return {
        version: 1,
        dimensions: [],
        risk_classes: {
          GIRR: {
            dimensions: [],
            buckets: { naming: "currency", values: ["USD-IRS"] },
            risk_weights_ref: "girr_delta_weights",
            intra_bucket_correlation_ref: "girr_rho_kl",
            cross_bucket_correlation_ref: "girr_gamma_bc",
          },
        },
        frtb_binding: {
          risk_class: "risk_class", bucket: "bucket", tenor: "tenor",
          risk_value: "risk_value", weight: "weight", sensitivity_type: "sensitivity_type",
        },
        risk_weights: {
          girr_delta_weights: {
            by_tenor: { "3M": 0.017, "6M": 0.017, "1Y": 0.016, "2Y": 0.013, "3Y": 0.012 },
          },
        },
        correlations: {},
      } as unknown as Schema;
    }

    function equityOnlySchema(): Schema {
      return {
        version: 1,
        dimensions: [],
        risk_classes: {
          Equity: {
            dimensions: [],
            buckets: { naming: "bucket-id", values: ["6"] },
            risk_weights_ref: "equity_weights",
            intra_bucket_correlation_ref: "equity_rho",
            cross_bucket_correlation_ref: "equity_gamma",
          },
        },
        frtb_binding: {
          risk_class: "risk_class", bucket: "bucket", tenor: "tenor",
          risk_value: "risk_value", weight: "weight", sensitivity_type: "sensitivity_type",
        },
        risk_weights: {
          equity_weights: { by_bucket: { "6": 0.35 } },
        },
        correlations: {},
      } as unknown as Schema;
    }

    it("GIRR Delta — populates doc.risk_value from side-table HGETALL and doc.weight from schema", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXAA",
            // hash-sidetable variant: parent HASH has no raw risk_value field
            // (the writer only stores the pre-weighted ws_* numerics).
            doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta" },
          },
        ]),
      );
      // Side-table reply for `{sens:01HXAA}:tenors` — flat per-tenor map
      // mirroring what `sideTableArgsFor` would HSET (numeric strings keyed
      // by tenor label).
      fr.setResponse("HGETALL", (args) => {
        if (String(args[0]) === "{sens:01HXAA}:tenors") {
          return ["3M", "0.5", "6M", "1.25", "1Y", "2.0"];
        }
        return [];
      });
      app = await createServer({ redis: fr, schema: girrOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=GIRR&bucket=USD-IRS&sensitivity_type=Delta",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].doc.risk_value).toEqual({ "3M": 0.5, "6M": 1.25, "1Y": 2.0 });
      // Schema-derived per-tenor weight object.
      expect(body.rows[0].doc.weight).toEqual({
        "3M": 0.017, "6M": 0.017, "1Y": 0.016, "2Y": 0.013, "3Y": 0.012,
      });
    });

    it("GIRR Curvature — round-trips cvr_up / cvr_down arrays stored as JSON in side-table", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXCC",
            doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Curvature" },
          },
        ]),
      );
      // Forward-compat shape: a future hash-sidetable variant could JSON-
      // encode the cvr_up/cvr_down legs into the same side-table HASH.
      fr.setResponse("HGETALL", (args) => {
        if (String(args[0]) === "{sens:01HXCC}:tenors") {
          return [
            "cvr_up", JSON.stringify([0.1, 0.2, 0.3]),
            "cvr_down", JSON.stringify([-0.1, -0.2, -0.3]),
          ];
        }
        return [];
      });
      app = await createServer({ redis: fr, schema: girrOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=GIRR&bucket=USD-IRS&sensitivity_type=Curvature",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rows[0].doc.risk_value).toEqual({
        cvr_up: [0.1, 0.2, 0.3],
        cvr_down: [-0.1, -0.2, -0.3],
      });
    });

    it("Equity Delta — no side-table key (HGETALL empty) leaves doc.risk_value undefined; weight resolves from by_bucket", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXEE",
            doc: { risk_class: "Equity", bucket: "6", sensitivity_type: "Delta" },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: equityOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=Equity&bucket=6&sensitivity_type=Delta",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].doc.risk_value).toBeUndefined();
      // by_bucket lookup → scalar weight.
      expect(body.rows[0].doc.weight).toBe(0.35);
    });

    it("pipelines HGETALL into a single round-trip across multiple rows needing enrichment", async () => {
      const fr = fakeRedis();
      let pipelineInvocations = 0;
      const origPipeline = fr.pipeline.bind(fr);
      fr.pipeline = () => {
        pipelineInvocations += 1;
        return origPipeline();
      };
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(3, [
          { key: "sens:AAA", doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta" } },
          { key: "sens:BBB", doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta" } },
          { key: "sens:CCC", doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta" } },
        ]),
      );
      fr.setResponse("HGETALL", ["3M", "0.1"]);
      app = await createServer({ redis: fr, schema: girrOnlySchema() });
      const res = await app.inject({ method: "GET", url: "/pivot?risk_class=GIRR" });
      expect(res.statusCode).toBe(200);
      // Three HGETALL operations, but only one pipeline → single round-trip.
      expect(pipelineInvocations).toBe(1);
      const hgetalls = fr.calls.filter((c) => c.command === "HGETALL");
      expect(hgetalls).toHaveLength(3);
      expect(hgetalls[0]!.args[0]).toBe("{sens:AAA}:tenors");
      expect(hgetalls[1]!.args[0]).toBe("{sens:BBB}:tenors");
      expect(hgetalls[2]!.args[0]).toBe("{sens:CCC}:tenors");
    });

    it("does not overwrite an already-populated doc.risk_value / doc.weight (legacy json variant)", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXFF",
            doc: {
              risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta",
              risk_value: { "3M": 9.99 }, weight: 0.123,
            },
          },
        ]),
      );
      // If the route incorrectly HGETALLs anyway, this would override the doc.
      fr.setResponse("HGETALL", ["3M", "0.0001"]);
      app = await createServer({ redis: fr, schema: girrOnlySchema() });
      const res = await app.inject({ method: "GET", url: "/pivot?risk_class=GIRR" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rows[0].doc.risk_value).toEqual({ "3M": 9.99 });
      expect(body.rows[0].doc.weight).toBe(0.123);
      // No HGETALL issued for the already-populated row.
      expect(fr.calls.filter((c) => c.command === "HGETALL")).toHaveLength(0);
    });
  });
});
