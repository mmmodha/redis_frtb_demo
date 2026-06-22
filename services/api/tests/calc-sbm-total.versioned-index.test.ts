// Wave 6.30.B2 — regression guard for literal `idx:sens` plumbing on the
// /calc/sbm/total orchestrator fanout. Reproduces the user-facing 412
// "idx:sens not found on '<target>' — bootstrap required" by injecting a
// fakeRedis where any FT.* call against the literal `idx:sens` throws
// "Unknown Index name" but the resolved versioned name (`idx:sens:vDEADBEE`)
// succeeds. The total-endpoint must transit every 27 cells without leaking a
// literal `idx:sens` into any FT.AGGREGATE / FT.INFO / FT.SEARCH call.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { __resetCalcCacheForTests } from "../src/sbm/calc-cache.ts";
import { clearSensIndexNameCache } from "../src/lib/sens-index.ts";

describe("POST /calc/sbm/total — versioned idx:sens plumbing (Wave 6.30.B2)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetCalcCacheForTests();
    clearSensIndexNameCache();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 (no 412) when only the versioned idx:sens:v* exists on the cluster", async () => {
    const fr = fakeRedis();
    const HASH = "DEADBEEFCAFE";          // schema-hash payload (≥7 chars)
    const VERSIONED = "idx:sens:vDEADBEE"; // first 7 chars → versioned name

    // bootstrap:schema-hash:<target> resolves to the versioned name via
    // getSensIndexName. Default active target label is "default" (see
    // active-target.ts defaultLabel).
    fr.setResponse("GET", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "bootstrap:schema-hash:default") return HASH;
      return null;
    });

    // Wave 6.24 — bucket discovery uses SMEMBERS on `seen:bucket:<rc>`
    // (Wave 7.0.6.6 — tag-free).
    // Set this BEFORE FT.AGGREGATE so the fake's auto-mirror shim is
    // skipped (it would otherwise route SMEMBERS through the FT.AGGREGATE
    // responder, which throws on unexpected first-args).
    fr.setResponse("SMEMBERS", ["USD-IRS"]);

    // Rollup short-circuit: empty HGETALL → tryRollupReadout returns null,
    // so the route falls through to the FT.AGGREGATE fast path.
    fr.setResponse("HGETALL", []);

    // The cluster carries the versioned index but NOT the literal alias.
    // Any FT.AGGREGATE / FT.INFO call carrying the literal `idx:sens`
    // mimics RediSearch's real "Unknown Index name" reply; the versioned
    // name succeeds.
    fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
      const idx = String(args[0]);
      if (idx === "idx:sens") {
        throw new Error("Unknown Index name");
      }
      if (idx === VERSIONED) {
        return [1, ["bucket", "USD-IRS"]];
      }
      throw new Error(`unexpected FT.AGGREGATE index: ${idx}`);
    });
    fr.setResponse("FT.INFO", (args: unknown[]) => {
      const idx = String(args[0]);
      if (idx === "idx:sens") {
        throw new Error("Unknown Index name");
      }
      return ["index_name", idx, "num_docs", "1000"];
    });
    fr.setResponse("FCALL", (args: unknown[]) => {
      const bucket = String(args[4]);
      return ["K_b", "3", "S_b", "3", "count", "100", "ms", "5", "_b", bucket];
    });

    app = await createServer({
      redis: fr,
      correlations: {
        GIRR: { kind: "constant", value: 0 },
        EQUITY: { kind: "constant", value: 0 },
        FX: { kind: "constant", value: 0 },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/total?nocache=1",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toMatch(/idx:sens not found/);
    expect(body).not.toMatch(/bootstrap required/);

    // Also verify no FT.* call leaked the literal name into the cluster.
    const leakedFtCalls = fr.calls.filter(
      (c) =>
        (c.command === "FT.AGGREGATE" || c.command === "FT.INFO" || c.command === "FT.SEARCH")
        && c.args[0] === "idx:sens",
    );
    expect(leakedFtCalls).toEqual([]);
  });
});
