import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../../src/server.ts";
import { fakeRedis } from "../helpers/fake-redis.ts";

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

describe("GET /facets", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  afterEach(async () => {
    if (app) await app.close();
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
    fr.setResponse("FT.AGGREGATE", aggReply([]));
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty-index");
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
});
