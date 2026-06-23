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

    it("GIRR Curvature — Wave 6.47.C __shape__=curvature_per_tenor reconstructs cvr_up/cvr_down arrays", async () => {
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
      // Wave 6.47.C — writer JSON-encodes the cvr_up/cvr_down arrays and
      // tags the side-table HASH with `__shape__=curvature_per_tenor` so
      // the reader branches on the discriminator (not on field names).
      fr.setResponse("HGETALL", (args) => {
        if (String(args[0]) === "{sens:01HXCC}:tenors") {
          return [
            "__shape__", "curvature_per_tenor",
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

    it("Equity Delta — Wave 6.47.C __shape__=scalar reconstructs {spot}", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXES",
            doc: { risk_class: "Equity", bucket: "6", sensitivity_type: "Delta" },
          },
        ]),
      );
      fr.setResponse("HGETALL", (args) => {
        if (String(args[0]) === "{sens:01HXES}:tenors") {
          return ["__shape__", "scalar", "spot", "0.42"];
        }
        return [];
      });
      app = await createServer({ redis: fr, schema: equityOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=Equity&bucket=6&sensitivity_type=Delta",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rows[0].doc.risk_value).toEqual({ spot: 0.42 });
    });

    it("backwards-compat — no __shape__ discriminator on side-table → treat all keys as tenor labels", async () => {
      // Wave 6.47.C — pre-6.47.C rows on the side-table never carry a
      // `__shape__` field. The reader must keep round-tripping them as
      // tenor → number objects exactly as it did before the discriminator
      // was introduced.
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXOLD",
            doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta" },
          },
        ]),
      );
      fr.setResponse("HGETALL", (args) => {
        if (String(args[0]) === "{sens:01HXOLD}:tenors") {
          return ["3M", "0.5", "1Y", "2.0"];
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
      expect(body.rows[0].doc.risk_value).toEqual({ "3M": 0.5, "1Y": 2.0 });
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

  // Wave 7.0.6.23 — the bulk-loader (services/bulk-loader/src/worker.ts
  // `rowToHashFields`) is the canonical ingest path on Wave 7.0+ and writes
  // the raw sensitivity onto the parent `sens:<ulid>` HASH as flattened
  // `s_<class>_<leg>[_<tenor>]` fields, but it does NOT populate the legacy
  // `{sens:<ulid>}:tenors` sidetable (introducing one would re-create the
  // hash-tag hot-shard pattern Wave 6.31 eliminated). /pivot reconstructs
  // `risk_value` from those parent-HASH fields before falling through to
  // the sidetable HGETALL for pre-7.0 `hash-sidetable` rows.
  describe("Wave 7.0.6.23 — parent-HASH risk_value reconstruction", () => {
    function girrFullSchema(): Schema {
      return {
        version: 1,
        dimensions: [],
        risk_classes: {
          GIRR: {
            dimensions: [],
            buckets: { naming: "currency", values: ["USD-IRS"] },
            tenor: { count: 3, nodes: ["3M", "6M", "1Y"] },
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
          girr_delta_weights: { by_tenor: { "3M": 0.017, "6M": 0.017, "1Y": 0.016 } },
        },
        correlations: {},
      } as unknown as Schema;
    }

    function scalarOnlySchema(): Schema {
      return {
        version: 1,
        dimensions: [],
        risk_classes: {
          FX: {
            dimensions: [],
            buckets: { naming: "currency-pair", values: ["EURUSD"] },
            risk_weights_ref: "fx_delta_weights",
            intra_bucket_correlation_ref: "fx_rho",
            cross_bucket_correlation_ref: "fx_gamma",
          },
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
          fx_delta_weights: { constant: 0.15 },
          equity_weights: { by_bucket: { "6": 0.35 } },
        },
        correlations: {},
      } as unknown as Schema;
    }

    it("GIRR Delta per-tenor — reconstructs tenor-keyed object including zero-padded tenors", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXAA",
            doc: {
              risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta",
              s_girr_delta_3M: "0.1", s_girr_delta_6M: "0.2", s_girr_delta_1Y: "0",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: girrFullSchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=GIRR&bucket=USD-IRS&sensitivity_type=Delta",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rows[0].doc.risk_value).toEqual({ "3M": 0.1, "6M": 0.2, "1Y": 0 });
      // s_* fields stripped from the response.
      expect(body.rows[0].doc.s_girr_delta_3M).toBeUndefined();
      expect(body.rows[0].doc.s_girr_delta_6M).toBeUndefined();
      expect(body.rows[0].doc.s_girr_delta_1Y).toBeUndefined();
    });

    it("GIRR Vega per-tenor — reads s_girr_vega_<t> fields", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXVA",
            doc: {
              risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Vega",
              s_girr_vega_3M: "0.5", s_girr_vega_6M: "0.6", s_girr_vega_1Y: "0",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: girrFullSchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=GIRR&sensitivity_type=Vega",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows[0].doc.risk_value).toEqual({ "3M": 0.5, "6M": 0.6, "1Y": 0 });
    });

    it("GIRR Curvature per-tenor — reconstructs positional cvr_up/cvr_down arrays in nodes order", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXCV",
            doc: {
              risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Curvature",
              s_girr_cvr_up_3M: "0.1", s_girr_cvr_up_6M: "0.2", s_girr_cvr_up_1Y: "0.3",
              s_girr_cvr_down_3M: "-0.1", s_girr_cvr_down_6M: "-0.2", s_girr_cvr_down_1Y: "-0.3",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: girrFullSchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=GIRR&sensitivity_type=Curvature",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows[0].doc.risk_value).toEqual({
        cvr_up: [0.1, 0.2, 0.3],
        cvr_down: [-0.1, -0.2, -0.3],
      });
    });

    it("FX Delta scalar — reconstructs {spot} from s_fx_delta", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXFD",
            doc: {
              risk_class: "FX", bucket: "EURUSD", sensitivity_type: "Delta",
              s_fx_delta: "-0.143",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: scalarOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=FX&sensitivity_type=Delta",
      });
      expect(res.statusCode).toBe(200);
      const doc = res.json().rows[0].doc;
      expect(doc.risk_value).toEqual({ spot: -0.143 });
      expect(doc.s_fx_delta).toBeUndefined();
    });

    it("FX Vega scalar — reconstructs {spot} from s_fx_vega", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXFV",
            doc: {
              risk_class: "FX", bucket: "EURUSD", sensitivity_type: "Vega",
              s_fx_vega: "0.5",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: scalarOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=FX&sensitivity_type=Vega",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows[0].doc.risk_value).toEqual({ spot: 0.5 });
    });

    it("FX Curvature scalar — reconstructs {cvr_up, cvr_down} numerics", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXFC",
            doc: {
              risk_class: "FX", bucket: "EURUSD", sensitivity_type: "Curvature",
              s_fx_cvr_up: "1.2", s_fx_cvr_down: "-0.8",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: scalarOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=FX&sensitivity_type=Curvature",
      });
      expect(res.statusCode).toBe(200);
      const doc = res.json().rows[0].doc;
      expect(doc.risk_value).toEqual({ cvr_up: 1.2, cvr_down: -0.8 });
      expect(doc.s_fx_cvr_up).toBeUndefined();
      expect(doc.s_fx_cvr_down).toBeUndefined();
    });

    it("Equity Delta scalar (bucket-based class, no tenor nodes) — {spot} from s_equity_delta", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXED",
            doc: {
              risk_class: "Equity", bucket: "6", sensitivity_type: "Delta",
              s_equity_delta: "0.1",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: scalarOnlySchema() });
      const res = await app.inject({
        method: "GET",
        url: "/pivot?risk_class=Equity&bucket=6&sensitivity_type=Delta",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows[0].doc.risk_value).toEqual({ spot: 0.1 });
    });

    it("NaN tolerance — non-finite per-tenor field is skipped, surrounding tenors still present", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXNA",
            doc: {
              risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta",
              s_girr_delta_3M: "NaN", s_girr_delta_6M: "0.2", s_girr_delta_1Y: "0",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: girrFullSchema() });
      const res = await app.inject({ method: "GET", url: "/pivot?risk_class=GIRR" });
      expect(res.statusCode).toBe(200);
      // 3M is dropped (NaN, non-finite); 6M / 1Y are retained as numbers.
      expect(res.json().rows[0].doc.risk_value).toEqual({ "6M": 0.2, "1Y": 0 });
    });

    it("no s_* fields → reconstruction is a no-op and the legacy sidetable HGETALL path runs", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXLG",
            // Pre-7.0 hash-sidetable row: parent HASH has no s_* fields.
            doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta" },
          },
        ]),
      );
      fr.setResponse("HGETALL", (args) => {
        if (String(args[0]) === "{sens:01HXLG}:tenors") {
          return ["3M", "0.5", "6M", "1.25"];
        }
        return [];
      });
      app = await createServer({ redis: fr, schema: girrFullSchema() });
      const res = await app.inject({ method: "GET", url: "/pivot?risk_class=GIRR" });
      expect(res.statusCode).toBe(200);
      // Sidetable HGETALL filled risk_value.
      expect(res.json().rows[0].doc.risk_value).toEqual({ "3M": 0.5, "6M": 1.25 });
      // Sidetable HGETALL was issued (one row, one HGETALL).
      expect(fr.calls.filter((c) => c.command === "HGETALL")).toHaveLength(1);
    });

    it("response cleanup — every s_* field is stripped from the doc after reconstruction", async () => {
      const fr = fakeRedis();
      fr.setResponse(
        "FT.SEARCH",
        ftSearchReply(1, [
          {
            key: "sens:01HXST",
            doc: {
              risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Curvature",
              s_girr_cvr_up_3M: "0.1", s_girr_cvr_up_6M: "0.2", s_girr_cvr_up_1Y: "0.3",
              s_girr_cvr_down_3M: "-0.1", s_girr_cvr_down_6M: "-0.2", s_girr_cvr_down_1Y: "-0.3",
            },
          },
        ]),
      );
      fr.setResponse("HGETALL", []);
      app = await createServer({ redis: fr, schema: girrFullSchema() });
      const res = await app.inject({ method: "GET", url: "/pivot?risk_class=GIRR" });
      expect(res.statusCode).toBe(200);
      const doc = res.json().rows[0].doc;
      for (const k of Object.keys(doc)) {
        expect(k.startsWith("s_")).toBe(false);
      }
    });
  });
});
