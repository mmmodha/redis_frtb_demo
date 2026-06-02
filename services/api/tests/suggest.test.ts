import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

// Wave 5.30a — unit suite for GET /suggest. Drives the route against the
// in-memory fakeRedis: every FT.SUGGET / FT.SUGLEN call lands as a recorded
// entry on fr.calls so the tests can both assert the exact argv shape and
// craft canned replies for the happy-path / empty-dictionary branches.

describe("GET /suggest", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("happy path: returns parsed suggestions with score and ms", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SUGGET", ["T0100", "1", "T0101", "2", "T0102", "1"]);
    app = await createServer({ redis: fr });

    const res = await app.inject({
      method: "GET",
      url: "/suggest?field=trade_id&prefix=T01&max=10",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestions).toEqual([
      { value: "T0100", score: 1 },
      { value: "T0101", score: 2 },
      { value: "T0102", score: 1 },
    ]);
    expect(typeof body.ms).toBe("number");
    expect(body.ms).toBeGreaterThanOrEqual(0);

    const call = fr.calls.find((c) => c.command === "FT.SUGGET");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("sug:trade_id");
    expect(call!.args[1]).toBe("T01");
    expect(call!.args).toContain("FUZZY");
    expect(call!.args).toContain("WITHSCORES");
    expect(call!.args).toContain("MAX");
    expect(call!.args).toContain("10");
  });

  it("503 when FT.SUGGET returns empty and FT.SUGLEN reports an empty dictionary", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SUGGET", []);
    fr.setResponse("FT.SUGLEN", 0);
    app = await createServer({ redis: fr });

    const res = await app.inject({
      method: "GET",
      url: "/suggest?field=book&prefix=RA",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: "no-suggester-or-data",
      field: "book",
      hint: "ensure bootstrap backfill ran or the ingest stream has produced rows",
    });
  });

  it("200 with empty suggestions when dictionary is populated but prefix has no match", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SUGGET", []);
    fr.setResponse("FT.SUGLEN", 42);
    app = await createServer({ redis: fr });

    const res = await app.inject({
      method: "GET",
      url: "/suggest?field=trade_id&prefix=ZZZZ",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestions).toEqual([]);
  });

  it("400 on unknown field", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/suggest?field=desk&prefix=A" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/field must be one of/);
  });

  it("400 on missing field", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/suggest?prefix=A" });
    expect(res.statusCode).toBe(400);
  });

  it("400 on empty prefix", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/suggest?field=book&prefix=" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/prefix is required/);
  });

  it("400 on out-of-range max (0, 51, non-numeric)", async () => {
    app = await createServer({ redis: fakeRedis() });
    for (const v of ["0", "51", "abc"]) {
      const res = await app.inject({ method: "GET", url: `/suggest?field=book&prefix=A&max=${v}` });
      expect(res.statusCode, `max=${v}`).toBe(400);
      expect(res.json().error, `max=${v}`).toMatch(/max must be an integer/);
    }
  });

  it("fuzzy=0 omits FUZZY from the FT.SUGGET argv", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SUGGET", ["BOOK1", "1"]);
    app = await createServer({ redis: fr });

    const res = await app.inject({
      method: "GET",
      url: "/suggest?field=book&prefix=BO&fuzzy=0&max=5",
    });
    expect(res.statusCode).toBe(200);
    const call = fr.calls.find((c) => c.command === "FT.SUGGET")!;
    expect(call.args).not.toContain("FUZZY");
    expect(call.args).toContain("WITHSCORES");
    expect(call.args).toContain("MAX");
    expect(call.args).toContain("5");
  });

  it("400 on invalid fuzzy value", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/suggest?field=book&prefix=A&fuzzy=2" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/fuzzy must be/);
  });

  it("503 when FT.SUGGET errors with no-such-key", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SUGGET", () => { throw new Error("ERR no such key"); });
    app = await createServer({ redis: fr });
    const res = await app.inject({
      method: "GET",
      url: "/suggest?field=risk_factor&prefix=RF",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("no-suggester-or-data");
  });
});
