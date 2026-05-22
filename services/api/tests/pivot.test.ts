import { describe, it, expect, afterEach } from "vitest";
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
          key: "sens:{GIRR:USD-IRS}:01HXAA",
          doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", risk_value: [0.1, 0.2] },
        },
        {
          key: "sens:{GIRR:USD-IRS}:01HXBB",
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
    expect(body.rows[0].key).toBe("sens:{GIRR:USD-IRS}:01HXAA");
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
});
