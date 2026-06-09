import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { __resetCalcCacheForTests } from "../src/sbm/calc-cache.ts";
// Wave 5.83B-fix — pull enrichDoc straight from the ingest package so the
// parity tests below build the FT.AGGREGATE row from the same code path the
// consumer runs at ingest time (no risk of the test drifting from the live
// per-leg weighting rule).
import { enrichDoc } from "../../ingest/src/consumer.ts";

// FT.AGGREGATE reply for GROUPBY @bucket → returns ["total", "@bucket", "USD-IRS", "@bucket", "EUR-IRS", ...]
// Per Redis docs, FT.AGGREGATE returns [total, ...replies]
function ftAggregateReply(buckets: string[]) {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}

describe("POST /calc/sbm — MVP endpoint", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    // Wave 5.83C-2 — the route now caches successful response bodies for 30 s
    // keyed by body+data_version. Tests share the default identity, so reset
    // module-global cache state between cases to avoid cross-test bleed.
    __resetCalcCacheForTests();
  });
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
      expect(c.args[0]).toBe("sbm_delta_bucket");
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

  it("Vega routes to sbm_vega_bucket and accepts case-insensitive sensitivity_type", async () => {
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
    expect(fc!.args[0]).toBe("sbm_vega_bucket");
  });

  it("Equity routes Delta to equity_delta and Vega to equity_vega", async () => {
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
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("equity_delta");

    fr.calls.length = 0;
    const vega = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "Equity", sensitivity_type: "Vega" },
    });
    expect(vega.statusCode).toBe(200);
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("equity_vega");
  });

  it("FX routes Delta to fx_delta and Vega to fx_vega", async () => {
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
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("fx_delta");

    fr.calls.length = 0;
    const vega = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "FX", sensitivity_type: "Vega" },
    });
    expect(vega.statusCode).toBe(200);
    expect(fr.calls.find((c) => c.command === "FCALL")!.args[0]).toBe("fx_vega");
  });

  it("returns 400 on missing risk_class or invalid sensitivity_type", async () => {
    app = await createServer({ redis: fakeRedis() });
    const a = await app.inject({ method: "POST", url: "/calc/sbm", payload: {} });
    expect(a.statusCode).toBe(400);
    // Wave 5.16c: Curvature is now a first-class leg; an unknown sensitivity
    // type ("Foo") still returns 400.
    const b = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Foo" },
    });
    expect(b.statusCode).toBe(400);
  });

  // Wave 5.16c: Curvature dispatch. Each risk_class routes Curvature to its
  // dedicated FCALL (girr_curvature / equity_curvature / fx_curvature) and the
  // reduce step uses reduceCurvatureCharge (§21.5(5) γ² + ψ-gated cross terms).
  // For γ=0 the cross term vanishes and the risk-class charge collapses to
  // √(ΣK_b²) — same as the Delta/Vega γ=0 sanity case.
  const curvatureRouteCases: Array<{ riskClass: string; funcName: string; buckets: string[] }> = [
    { riskClass: "GIRR", funcName: "girr_curvature", buckets: ["USD-IRS", "EUR-IRS"] },
    { riskClass: "Equity", funcName: "equity_curvature", buckets: ["1", "5"] },
    { riskClass: "FX", funcName: "fx_curvature", buckets: ["EURUSD", "GBPUSD"] },
  ];
  it.each(curvatureRouteCases)(
    "Wave 5.16c: $riskClass Curvature routes to $funcName and reduces via §21.5(5)",
    async ({ riskClass, funcName, buckets }) => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(buckets));
      // Stub Curvature FCALL replies — bucket-level K_b/S_b already resolved by
      // the Lua function (it picks the worse of K_b^+/K_b^- per §21.5(3)).
      fr.setResponse("FCALL", (args: unknown[]) => {
        const bucket = String(args[4]);
        if (bucket === buckets[0]) {
          return ["K_b", "3", "S_b", "3", "count", "10", "ms", "1"];
        }
        return ["K_b", "4", "S_b", "4", "count", "20", "ms", "1"];
      });
      app = await createServer({
        redis: fr,
        // γ_delta = 0 → γ_curv = 0² = 0 → charge = √(9+16) = 5.
        correlations: { [riskClass.toUpperCase()]: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: riskClass, sensitivity_type: "Curvature" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.charge).toBeCloseTo(5, 10);
      expect(body.per_bucket).toHaveLength(2);
      expect(body.total_ms).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(body.shard_breakdown)).toBe(true);
      // Wave 5.19: curvature responses surface the §21.5(5) branch decision.
      // Positive-interior fixture (both S_b=3) → "positive_interior".
      expect(body.curvature_branch).toBe("positive_interior");
      // Routing: every FCALL hits the curvature function for this risk class.
      const fcalls = fr.calls.filter((c) => c.command === "FCALL");
      expect(fcalls).toHaveLength(2);
      for (const c of fcalls) {
        expect(c.args[0]).toBe(funcName);
        expect(String(c.args[2])).toMatch(/^sens:\{[A-Z]+:[^}]+\}:_route$/);
      }
    },
  );

  // Wave 5.19: curvature_branch must be OMITTED (not null) for non-curvature
  // legs so the UI's `result.curvature_branch != null` gate is unambiguous.
  it("Wave 5.19: omits curvature_branch from Delta/Vega responses", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "10", "ms", "1"]);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect("curvature_branch" in body).toBe(false);
  });

  // Wave 5.8.4 + 5.15d.1: a 200 with charge=0 on a portfolio that has no rows
  // (or no idx:sens on some shards) silently masks a precondition failure. The
  // route must hard-fail with a diagnostic 503 when the cluster-aware discover
  // step finds no buckets AND FT.INFO reports num_docs=0.
  it("returns 503 no-data-or-index when FT.AGGREGATE is empty AND FT.INFO num_docs is 0", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    // FT.INFO returns a flat key/value array; num_docs is cluster-aggregated
    // by ioredis Cluster's coordinator (sum across masters).
    fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "0"]);
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

    // Verify the precondition probe was issued against idx:sens.
    const info = fr.calls.find((c) => c.command === "FT.INFO");
    expect(info).toBeDefined();
    expect(info!.args[0]).toBe("idx:sens");
    // FCALL must NOT be issued when the precondition failed.
    expect(fr.calls.find((c) => c.command === "FCALL")).toBeUndefined();
  });

  it("returns 503 no-data-or-index when FT.INFO itself errors (missing index)", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    // Simulate `idx:sens` missing — FT.INFO throws.
    fr.setResponse("FT.INFO", () => {
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

  // Wave 5.41: explicit per-call TIMEOUT on the discovery FT.AGGREGATE so a
  // slow cluster surfaces as a captured 502 instead of an indefinite hang
  // behind the module's implicit default. Locked in the call-args mirror so
  // any future refactor that drops the TIMEOUT pair regresses this test.
  it("Wave 5.41: discovery FT.AGGREGATE carries TIMEOUT 30000 in its arg list", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
    expect(agg).toBeDefined();
    const args = agg!.args;
    const ti = args.indexOf("TIMEOUT");
    expect(ti).toBeGreaterThan(-1);
    expect(args[ti + 1]).toBe("30000");
  });

  // Wave 5.41: when FT.AGGREGATE throws but FT.INFO reports a populated
  // index (num_docs > 0), the route surfaces 502 "discovery-failed" with the
  // upstream error message — replacing the previous silent fall-through that
  // returned 200 + charge=0 and masked the real cause.
  it("Wave 5.41: 502 discovery-failed when FT.AGGREGATE throws and FT.INFO num_docs > 0", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", () => {
      throw new Error("Search timeout exceeded");
    });
    fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "1000000"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body).toMatchObject({
      error: "discovery-failed",
      reason: "Search timeout exceeded",
    });
    expect(typeof body.hint).toBe("string");
    expect(body.hint).toMatch(/FT\.AGGREGATE/);
    // FCALL must NOT fire when discovery failed.
    expect(fr.calls.find((c) => c.command === "FCALL")).toBeUndefined();
  });

  // Wave 5.41: the same throw path also emits a structured warn log with
  // evt=calc-discovery-failed so ops can correlate the 502 with the
  // underlying Redis error in the api log stream.
  it("Wave 5.41: warn-log captures evt: calc-discovery-failed on the throw path", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", () => {
      throw new Error("Search timeout exceeded");
    });
    fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "1000000"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const warnings: unknown[] = [];
    // Fastify's no-op logger still exposes `warn`; replace it with a capturing
    // spy so we can assert the event shape without flipping `logger: true`
    // (which would spam stdout for the whole suite).
    (app.log as unknown as { warn: (obj: unknown) => void }).warn = (obj: unknown) => {
      warnings.push(obj);
    };
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(502);
    const hit = warnings.find(
      (w) => typeof w === "object" && w !== null && (w as { evt?: string }).evt === "calc-discovery-failed",
    ) as Record<string, unknown> | undefined;
    expect(hit).toBeDefined();
    expect(hit!.err).toBe("Search timeout exceeded");
    expect(hit!.risk_class).toBe("GIRR");
    expect(String(hit!.query)).toContain("@risk_class:{GIRR}");
  });

  // Wave 5.15d.1: in cluster mode the FT.AGGREGATE coordinator does NOT
  // aggregate replies across shards (only FT.INFO does). The route must fan
  // out FT.AGGREGATE per master via redis.nodes("master") and union the
  // bucket sets in TS. This test wires a fake cluster client with two node
  // fakes that each own a disjoint slice of buckets and asserts the route
  // sees the union and FCALLs every bucket.
  it("cluster mode: fans FT.AGGREGATE per master and unions disjoint bucket sets", async () => {
    const nodeA = fakeRedis();
    const nodeB = fakeRedis();
    nodeA.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    nodeB.setResponse("FT.AGGREGATE", ftAggregateReply(["EUR-IRS"]));

    // Coordinator-level fake serves cluster-aggregated commands (FT.INFO) and
    // routed commands (FCALL). The cluster client exposes .nodes("master") so
    // the route's per-master fanout discovers nodeA + nodeB.
    const coord = fakeRedis();
    coord.setResponse("FCALL", (args: unknown[]) => {
      const bucket = args[4] as string;
      if (bucket === "USD-IRS") return ["K_b", "3", "S_b", "3", "count", "10", "ms", "1"];
      return ["K_b", "4", "S_b", "4", "count", "20", "ms", "1"];
    });
    const cluster = {
      ...coord,
      nodes: (_role: string) => [nodeA, nodeB],
    };

    app = await createServer({
      redis: cluster as unknown as Parameters<typeof createServer>[0]["redis"],
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Both masters' buckets must be present — union, not single-shard view.
    expect(body.per_bucket).toHaveLength(2);
    const seenBuckets = body.per_bucket.map((b: { bucket: string }) => b.bucket).sort();
    expect(seenBuckets).toEqual(["EUR-IRS", "USD-IRS"]);

    // Each node-level fake recorded exactly one FT.AGGREGATE.
    expect(nodeA.calls.filter((c) => c.command === "FT.AGGREGATE")).toHaveLength(1);
    expect(nodeB.calls.filter((c) => c.command === "FT.AGGREGATE")).toHaveLength(1);
    // FT.INFO was NOT called — buckets were non-empty so the probe short-circuited.
    expect(coord.calls.find((c) => c.command === "FT.INFO")).toBeUndefined();
    // FCALL ran on the coordinator (real ioredis routes by hash-tag).
    expect(coord.calls.filter((c) => c.command === "FCALL")).toHaveLength(2);
  });

  it("cluster mode: empty per-shard FT.AGGREGATE + FT.INFO num_docs > 0 → 200 with charge=0", async () => {
    // The precondition probe uses FT.INFO (cluster-aggregated num_docs). When
    // num_docs > 0 but the requested risk_class has no rows across either
    // master, the route returns 200 with an empty per_bucket — NOT 503,
    // because the index is populated for other risk classes.
    const nodeA = fakeRedis();
    const nodeB = fakeRedis();
    nodeA.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    nodeB.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    const coord = fakeRedis();
    coord.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "27000"]);
    const cluster = {
      ...coord,
      nodes: (_role: string) => [nodeA, nodeB],
    };
    app = await createServer({
      redis: cluster as unknown as Parameters<typeof createServer>[0]["redis"],
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().per_bucket).toHaveLength(0);
    // The probe was issued once on the coordinator (cluster-aggregated).
    expect(coord.calls.filter((c) => c.command === "FT.INFO")).toHaveLength(1);
  });

  // Wave 5.15l: cross-component regression. Drives an HTTP request through the
  // calc route against a fakeRedis whose discover/FCALL responses are wired to
  // simulate the production failure mode: stored keys/index tags carry
  // UPPERCASE risk_class ("sens:{GIRR:JPY}:*"), but the calc payload from
  // scripts/run-calc.sh sends lowercase ("girr"). Before the fix the route
  // passed lowercase straight into FT.AGGREGATE / FCALL / routeKey and the
  // Lua-side SCAN matched zero keys, yielding 200 + charge=0 (smoke-run-12 RED).
  // After the fix the route uppercases at entry so every downstream consumer
  // sees the canonical form and the call returns 200 + charge > 0.
  it("Wave 5.15l: lowercase request body matches stored UPPERCASE risk_class keys (calc-api-risk-class-case-pass-through)", async () => {
    const fr = fakeRedis();
    // Discover stage: simulate FT.SEARCH/AGGREGATE under the *production*
    // schema where TAG values are stored UPPERCASE. RediSearch TAG matching is
    // case-insensitive by default — so in practice the discover stage would
    // still find buckets even with a lowercase query — but the failure mode
    // we lock here is the SCAN/routeKey leg, so we keep discover responsive
    // to whatever case arrives (it returns buckets in both cases).
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["JPY", "AUD"]));
    // FCALL: mirror the Lua SCAN logic — only return non-zero K_b/count when
    // the risk_class argument matches the stored UPPERCASE shape. Lowercase
    // arg → SCAN miss → all-zero result (the smoke-run-12 RED signature).
    fr.setResponse("FCALL", (args: unknown[]) => {
      const riskClassArg = String(args[3]);
      if (riskClassArg === "GIRR") {
        return ["K_b", "5", "S_b", "5", "count", "10", "ms", "1"];
      }
      return ["K_b", "0", "S_b", "0", "count", "0", "ms", "1"];
    });
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    // POST lowercase body — exactly what scripts/run-calc.sh sent in smoke-run-12.
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "girr", sensitivity_type: "delta" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Pre-fix: FCALL received "girr" → zero K_b/count → charge=0.
    // Post-fix: route uppercases at entry → FCALL receives "GIRR" → non-zero.
    expect(body.charge).toBeGreaterThan(0);
    expect(body.per_bucket).toHaveLength(2);
    expect(body.per_bucket.every((pb: { count: number }) => pb.count > 0)).toBe(true);

    // Lock the downstream shape: routing key + FCALL arg + discover query all
    // carry the canonical UPPERCASE form regardless of inbound casing.
    const fc = fr.calls.find((c) => c.command === "FCALL");
    expect(fc).toBeDefined();
    expect(fc!.args[3]).toBe("GIRR");
    expect(String(fc!.args[2])).toMatch(/^sens:\{GIRR:[^}]+\}:_route$/);
    const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
    expect(agg).toBeDefined();
    expect(String(agg!.args[1])).toContain("@risk_class:{GIRR}");
  });

  it("standalone mode: bucket discovery still issues a single FT.AGGREGATE (no regression)", async () => {
    // Asserts the resolveQueryNodes feature-check correctly falls back to
    // [client] when .nodes() is absent (standalone Redis), so the call count
    // matches the pre-5.15d.1 behaviour.
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["B1"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
    app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    expect(fr.calls.filter((c) => c.command === "FT.AGGREGATE")).toHaveLength(1);
  });

  // Wave 5.16m: observability — the response surfaces the FT.AGGREGATE
  // discovery query and the FCALL fan-out shape so the UI can render the
  // exact Redis commands the route already executed. Read-only mirror.
  it("Wave 5.16m: response includes commands.{discovery,fcall} mirroring the dispatched calls", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS", "EUR-IRS", "JPY-IRS"]));
    fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "10", "ms", "1"]);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commands).toBeDefined();
    expect(body.commands.discovery.command).toBe("FT.AGGREGATE");
    expect(body.commands.discovery.index).toBe("idx:sens");
    expect(body.commands.discovery.query).toContain("@risk_class:{GIRR}");
    expect(body.commands.discovery.groupby).toEqual(["@bucket"]);
    expect(Array.isArray(body.commands.discovery.reducers)).toBe(true);
    expect(body.commands.fcall.command).toBe("FCALL");
    expect(typeof body.commands.fcall.function).toBe("string");
    expect(body.commands.fcall.function.length).toBeGreaterThan(0);
    expect(body.commands.fcall.function).toBe("sbm_delta_bucket");
    expect(body.commands.fcall.library).toBe("frtb");
    expect(typeof body.commands.fcall.arg_template).toBe("string");
    expect(body.commands.fcall.arg_template).toContain("FCALL");
    // One routing key per bucket the api fanned out to.
    expect(body.commands.fcall.dispatched_keys).toHaveLength(body.per_bucket.length);
    for (const k of body.commands.fcall.dispatched_keys) {
      expect(k).toMatch(/^sens:\{GIRR:[^}]+\}:_route$/);
    }
  });

  // Wave 5.31a: optional `bucket_subset` narrows the discovery FT.AGGREGATE
  // and only the surviving buckets get FCALL fan-out. FCALL/reduce internals
  // are untouched — the subset feeds them naturally via the narrowed buckets.
  describe("Wave 5.31a: bucket_subset discovery-layer filter", () => {
    it("narrows the FT.AGGREGATE discovery query to @bucket:{B1|B2|B3}", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD", "EUR", "GBP"]));
      fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "10", "ms", "1"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["USD", "EUR", "GBP"],
        },
      });
      expect(res.statusCode).toBe(200);
      const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
      expect(agg).toBeDefined();
      const q = String(agg!.args[1]);
      expect(q).toContain("@risk_class:{GIRR}");
      expect(q).toContain("@bucket:{USD|EUR|GBP}");
      // commands.discovery.query mirrors the dispatched string verbatim.
      expect(res.json().commands.discovery.query).toContain("@bucket:{USD|EUR|GBP}");
    });

    it("subset that intersects with populated data → math runs only over the surviving buckets", async () => {
      // γ=0 → charge = √(Σ K_b²). Subset to USD+EUR only (K=3, K=4) → √(9+16)=5,
      // while a full run over USD+EUR+GBP (K=3,4,5) would give √(9+16+25)=√50.
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        const q = String(args[1]);
        // The narrowed predicate restricts what the index returns.
        if (q.includes("@bucket:{")) return ftAggregateReply(["USD", "EUR"]);
        return ftAggregateReply(["USD", "EUR", "GBP"]);
      });
      fr.setResponse("FCALL", (args: unknown[]) => {
        const b = String(args[4]);
        if (b === "USD") return ["K_b", "3", "S_b", "3", "count", "10", "ms", "1"];
        if (b === "EUR") return ["K_b", "4", "S_b", "4", "count", "10", "ms", "1"];
        return ["K_b", "5", "S_b", "5", "count", "10", "ms", "1"];
      });
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["USD", "EUR"],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.per_bucket).toHaveLength(2);
      expect(body.charge).toBeCloseTo(5, 10);
      // FCALL only fired over the surviving buckets — not the full 3.
      expect(fr.calls.filter((c) => c.command === "FCALL")).toHaveLength(2);
    });

    it("subset filtering all-missing buckets → 200 with empty per_bucket + subset-aware note", async () => {
      const fr = fakeRedis();
      // Discovery for the subset returns nothing — the named buckets don't exist.
      fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
      // Precondition probe sees a populated index (other risk classes have data).
      fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "27000"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["AAA", "BBB"],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.per_bucket).toHaveLength(0);
      expect(body.charge).toBe(0);
      expect(body.note).toMatch(/No buckets in subset \[AAA,BBB\] have data for risk_class GIRR/);
    });

    it("num_docs === 0 + non-empty subset → still 503 (precondition wins)", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
      fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "0"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["USD"],
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "no-data-or-index" });
    });

    it("empty subset [] is treated as no subset (identical to omitting the field)", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD", "EUR"]));
      fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "10", "ms", "1"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: [],
        },
      });
      expect(res.statusCode).toBe(200);
      const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
      expect(String(agg!.args[1])).toBe("@risk_class:{GIRR}");
      expect(res.json().commands.discovery.query).toBe("@risk_class:{GIRR}");
    });

    it("rejects bucket_subset containing a non-string element with 400", async () => {
      app = await createServer({ redis: fakeRedis() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["USD", 42, "EUR"],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/array of non-empty strings/);
    });

    it("rejects bucket_subset over 256 entries with 400", async () => {
      app = await createServer({ redis: fakeRedis() });
      const tooMany = Array.from({ length: 257 }, (_, i) => `B${i}`);
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: tooMany,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/256/);
    });

    it("regression: omitting bucket_subset produces identical wire shape to pre-5.31a", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD", "EUR"]));
      fr.setResponse("FCALL", ["K_b", "2", "S_b", "2", "count", "10", "ms", "1"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Discovery query is the pre-5.31a single-predicate form.
      expect(body.commands.discovery.query).toBe("@risk_class:{GIRR}");
      const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
      expect(String(agg!.args[1])).toBe("@risk_class:{GIRR}");
      // Known response keys are still all present, no surprise additions tied
      // to subset handling (note/ok stay absent on the happy path).
      expect(body).not.toHaveProperty("note");
      expect(body).not.toHaveProperty("ok");
    });

    it("de-duplicates and uppercase-normalises subset values before query building", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD"]));
      fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["usd", "USD", "eur"],
        },
      });
      expect(res.statusCode).toBe(200);
      const agg = fr.calls.find((c) => c.command === "FT.AGGREGATE");
      const q = String(agg!.args[1]);
      // de-duplicated to USD,EUR and uppercased; order preserved by Set insertion.
      expect(q).toContain("@bucket:{USD|EUR}");
    });
  });

  // Wave 5.31b: Basel MAR21.6 correlation-regime selector. γ_bc is scaled by
  // {low:0.75, medium:1.0, high:1.25} with symmetric ±1 cap. The default
  // ("medium") is a no-op vs. pre-5.31b so the canonical Grand Total
  // 9 558.91465449378 holds on the full-dataset GIRR Delta run.
  describe("Wave 5.31b: correlation_regime cross-bucket γ scaler", () => {
    // Deterministic 3-bucket fixture: K=2, S=2 each → ΣK² = 12. With ρ=0.5
    // the medium-regime cross term is Σ_{i≠j} 0.5·2·2 = 6·2 = 12 across the
    // 6 ordered off-diagonal pairs → charge = √24. Scaling γ shifts the
    // cross term proportionally → ordering low < med < high is guaranteed.
    function frThreeBuckets() {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["A", "B", "C"]));
      fr.setResponse("FCALL", ["K_b", "2", "S_b", "2", "count", "10", "ms", "1"]);
      return fr;
    }
    const rho = 0.5;

    it("medium regime (default): γ unscaled → charge matches the pre-5.31b analytic value", async () => {
      const fr = frThreeBuckets();
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: rho } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // ΣK² = 12; cross = 6 pairs · (0.5 · 2 · 2) = 12 → √24
      expect(body.charge).toBeCloseTo(Math.sqrt(12 + 12), 10);
      expect(body.correlation_regime).toBe("medium");
      expect(body.commands.regime).toMatchObject({ name: "medium", factor: 1.0, cap: 1.0 });
    });

    it("low regime: γ × 0.75 → charge strictly less than medium", async () => {
      const fr = frThreeBuckets();
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: rho } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta", correlation_regime: "low" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // γ' = 0.375 → cross = 6 · (0.375 · 4) = 9 → √21
      expect(body.charge).toBeCloseTo(Math.sqrt(12 + 9), 10);
      expect(body.correlation_regime).toBe("low");
      expect(body.commands.regime.factor).toBe(0.75);
    });

    it("high regime: γ × 1.25 → charge strictly greater than medium (uncapped here)", async () => {
      const fr = frThreeBuckets();
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: rho } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta", correlation_regime: "high" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // γ' = 0.625 → cross = 6 · (0.625 · 4) = 15 → √27
      expect(body.charge).toBeCloseTo(Math.sqrt(12 + 15), 10);
      expect(body.correlation_regime).toBe("high");
      expect(body.commands.regime.factor).toBe(1.25);
    });

    it("low ≤ medium ≤ high ordering on the deterministic 3-bucket fixture", async () => {
      const charges: Record<string, number> = {};
      for (const regime of ["low", "medium", "high"] as const) {
        const fr = frThreeBuckets();
        const a = await createServer({
          redis: fr,
          correlations: { GIRR: { kind: "constant", value: rho } },
        });
        const res = await a.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: "Delta", correlation_regime: regime },
        });
        charges[regime] = res.json().charge as number;
        await a.close();
      }
      expect(charges.low!).toBeLessThan(charges.medium!);
      expect(charges.medium!).toBeLessThan(charges.high!);
    });

    it("high regime with γ ≈ 1.0 hits the ±1 cap (cross term does not explode)", async () => {
      // γ = 0.95 · 1.25 = 1.1875 → clamps to 1.0. ΣK²=12 + cross=6·(1·4)=24 → √36 = 6.
      const fr = frThreeBuckets();
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0.95 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta", correlation_regime: "high" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().charge).toBeCloseTo(Math.sqrt(12 + 24), 10);
    });

    // Curvature: γ_curv = (γ × factor)² per the scale-first-then-square order
    // §21.5(5) + §21.6. Two-bucket fixture is hand-computable: K=3,K=4 → ΣK²=25;
    // γ_delta=0.5, S=3,S=4 → cross = 2 · γ²·12 → charge = √(25 + 24·γ²).
    //   low:    γ' = 0.375 → 24·0.140625 = 3.375  → √28.375
    //   medium: γ' = 0.5   → 24·0.25     = 6      → √31
    //   high:   γ' = 0.625 → 24·0.390625 = 9.375  → √34.375
    it("curvature path: γ scaled FIRST then squared (hand-computed two-bucket)", async () => {
      const expected: Record<string, number> = {
        low: Math.sqrt(25 + 24 * 0.375 * 0.375),
        medium: Math.sqrt(25 + 24 * 0.5 * 0.5),
        high: Math.sqrt(25 + 24 * 0.625 * 0.625),
      };
      for (const regime of ["low", "medium", "high"] as const) {
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS", "EUR-IRS"]));
        fr.setResponse("FCALL", (args: unknown[]) => {
          const b = String(args[4]);
          if (b === "USD-IRS") return ["K_b", "3", "S_b", "3", "count", "10", "ms", "1"];
          return ["K_b", "4", "S_b", "4", "count", "10", "ms", "1"];
        });
        const a = await createServer({
          redis: fr,
          correlations: { GIRR: { kind: "constant", value: 0.5 } },
        });
        const res = await a.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: "Curvature", correlation_regime: regime },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().charge).toBeCloseTo(expected[regime]!, 9);
        await a.close();
      }
    });

    it("rejects an unknown regime string with 400", async () => {
      app = await createServer({ redis: fakeRedis() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta", correlation_regime: "extreme" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/low, medium, high/);
    });

    it("response echoes correlation_regime + surfaces commands.regime observability block", async () => {
      const fr = frThreeBuckets();
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: rho } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta", correlation_regime: "high" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.correlation_regime).toBe("high");
      expect(body.commands.regime).toMatchObject({
        name: "high",
        factor: 1.25,
        cap: 1.0,
      });
      expect(typeof body.commands.regime.note).toBe("string");
      expect(body.commands.regime.note).toMatch(/cap/i);
    });

    it("composes with bucket_subset (Wave 5.31a): subset narrows + regime scales the surviving cross term", async () => {
      // Subset to USD+EUR only (drops GBP). K=2 for survivors → ΣK²=8; 2 ordered
      // off-diagonal pairs → cross_med = 2·(0.5·4) = 4; cross_high = 2·(0.625·4) = 5.
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        const q = String(args[1]);
        if (q.includes("@bucket:{")) return ftAggregateReply(["USD", "EUR"]);
        return ftAggregateReply(["USD", "EUR", "GBP"]);
      });
      fr.setResponse("FCALL", ["K_b", "2", "S_b", "2", "count", "10", "ms", "1"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0.5 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["USD", "EUR"],
          correlation_regime: "high",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.per_bucket).toHaveLength(2);
      expect(body.charge).toBeCloseTo(Math.sqrt(8 + 5), 10);
      expect(body.correlation_regime).toBe("high");
    });

    // CRITICAL regression gate: omitting `correlation_regime` must keep the
    // wire-charge byte-identical to pre-5.31b. We replay the exact 2-bucket
    // fixture from the first describe-block and assert √(9+16)=5 (the test
    // already in the suite). The implementation guarantees this via factor=1.0
    // → scaleCorrelationSpec returns the spec by reference.
    it("regression: omitting correlation_regime preserves the pre-5.31b charge exactly", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS", "EUR-IRS"]));
      fr.setResponse("FCALL", (args: unknown[]) => {
        const bucket = args[4] as string;
        if (bucket === "USD-IRS") return ["K_b", "3", "S_b", "3", "count", "100", "ms", "5"];
        return ["K_b", "4", "S_b", "4", "count", "200", "ms", "6"];
      });
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.charge).toBeCloseTo(5, 10);
      // Default echo is "medium" — UI uses it to render the badge.
      expect(body.correlation_regime).toBe("medium");
    });
  });

  // Wave 5.31c: kernel-side row-exclusion predicate. The api marshals the
  // optional `exclude` body into 3 positional CSV FCALL args (book / trade_id
  // / risk_factor). The kernel's `_frtb_excluded` helper short-circuits in
  // book→trade_id→risk_factor order. We assert wire shape, validation gates,
  // and the byte-identical regression path when `exclude` is omitted.
  describe("Wave 5.31c: exclude predicate push-down (book / trade_id / risk_factor)", () => {
    it("forwards exclude lists as positional CSV args 5/6/7 in FCALL fan-out", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
      fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
      app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          exclude: {
            book: ["RATES-LDN", "RATES-NYC"],
            trade_id: ["T0042"],
            risk_factor: ["RF_GIRR_05", "RF_GIRR_06"],
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const fc = fr.calls.find((c) => c.command === "FCALL");
      expect(fc).toBeDefined();
      // args: [funcName, "1", routeKey, risk_class, bucket, book_csv, trade_csv, factor_csv]
      expect(fc!.args[5]).toBe("RATES-LDN,RATES-NYC");
      expect(fc!.args[6]).toBe("T0042");
      expect(fc!.args[7]).toBe("RF_GIRR_05,RF_GIRR_06");
    });

    it("regression: omitting `exclude` passes empty CSV strings — kernel takes the no-exclusion path", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
      fr.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "100", "ms", "5"]);
      app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const fc = fr.calls.find((c) => c.command === "FCALL");
      expect(fc).toBeDefined();
      // Empty CSV positionals — kernel's `_frtb_parse_csv_set` returns nil and
      // skips the predicate entirely (byte-identical to pre-5.31c).
      expect(fc!.args[5]).toBe("");
      expect(fc!.args[6]).toBe("");
      expect(fc!.args[7]).toBe("");
    });

    it("commands.fcall.arg_template surfaces the new positional args for the UI commands panel", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
      fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
      app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const tpl = res.json().commands.fcall.arg_template as string;
      expect(tpl).toContain("<exclude_book_csv>");
      expect(tpl).toContain("<exclude_trade_csv>");
      expect(tpl).toContain("<exclude_factor_csv>");
    });

    it("de-duplicates exclude values inside a single field before CSV marshalling", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
      fr.setResponse("FCALL", ["K_b", "1", "S_b", "1", "count", "1", "ms", "1"]);
      app = await createServer({ redis: fr, correlations: { GIRR: { kind: "constant", value: 0 } } });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          exclude: { book: ["A", "B", "A"] },
        },
      });
      expect(res.statusCode).toBe(200);
      const fc = fr.calls.find((c) => c.command === "FCALL");
      expect(fc!.args[5]).toBe("A,B");
    });

    it("rejects a non-array exclude.book with 400", async () => {
      app = await createServer({ redis: fakeRedis() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          exclude: { book: "not-an-array" },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/exclude\.book/);
    });

    it("rejects an exclude.book value containing a comma with 400 (CSV delimiter clash)", async () => {
      app = await createServer({ redis: fakeRedis() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          exclude: { book: ["A,B"] },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/comma/);
    });

    it("returns 413 when an exclude list exceeds 1,000 entries (Lua-memory guard)", async () => {
      app = await createServer({ redis: fakeRedis() });
      const tooMany = Array.from({ length: 1001 }, (_, i) => `B${i}`);
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          exclude: { trade_id: tooMany },
        },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toMatch(/1000/);
    });

    it("composes with bucket_subset (F1) and correlation_regime (F2) without touching them", async () => {
      // F1 narrows discovery; F2 scales γ; F3 sets CSV args 5/6/7. The three
      // filters are independent layers per the locked design — this test
      // proves the composition by asserting all three side-effects in one go.
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        const q = String(args[1]);
        if (q.includes("@bucket:{")) return ftAggregateReply(["USD", "EUR"]);
        return ftAggregateReply(["USD", "EUR", "GBP"]);
      });
      fr.setResponse("FCALL", ["K_b", "2", "S_b", "2", "count", "10", "ms", "1"]);
      app = await createServer({
        redis: fr,
        correlations: { GIRR: { kind: "constant", value: 0.5 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          bucket_subset: ["USD", "EUR"],
          correlation_regime: "high",
          exclude: { book: ["B1"], risk_factor: ["RF1"] },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // F1: discovery query narrowed to the subset.
      expect(String(body.commands.discovery.query)).toContain("@bucket:{USD|EUR}");
      // F2: regime echoed back at the chosen value.
      expect(body.correlation_regime).toBe("high");
      expect(body.commands.regime).toMatchObject({ name: "high", factor: 1.25 });
      // F3: the FCALL args carry the CSVs in the right slots.
      const fcalls = fr.calls.filter((c) => c.command === "FCALL");
      expect(fcalls).toHaveLength(2);
      for (const fc of fcalls) {
        expect(fc.args[5]).toBe("B1");
        expect(fc.args[6]).toBe("");
        expect(fc.args[7]).toBe("RF1");
      }
    });

    it("rejects when `exclude` is not an object (e.g. an array)", async () => {
      app = await createServer({ redis: fakeRedis() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: {
          risk_class: "GIRR",
          sensitivity_type: "Delta",
          exclude: ["not", "an", "object"],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/object/);
    });
  });

  // Wave 5.83C-1 — FT.AGGREGATE fast path replaces the per-bucket FCALL
  // fan-out with a single FT.AGGREGATE per master that returns per-bucket
  // pre-weighted aggregates (per-tenor for GIRR, scalar for Equity/FX). The
  // Lua kernel is retained behind CALC_FAST_PATH=0 for differential testing —
  // vitest.setup.ts defaults the flag to "0" so the legacy tests above keep
  // their FCALL-stub fakeRedis surface; these tests opt-in to fast path via
  // beforeEach/afterEach.
  describe("Wave 5.83C-1: FT.AGGREGATE fast path", () => {
    let savedFlag: string | undefined;
    beforeEach(() => {
      savedFlag = process.env.CALC_FAST_PATH;
      process.env.CALC_FAST_PATH = "1";
    });
    afterEach(() => {
      if (savedFlag === undefined) delete process.env.CALC_FAST_PATH;
      else process.env.CALC_FAST_PATH = savedFlag;
    });

    // Minimal in-memory schema fixture covering the three classes the fast
    // path exercises. ρ values are picked so the closed-form K_b is hand-
    // computable from the canned FT.AGGREGATE rows below.
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
            tenor: { count: 3, nodes: ["3M", "6M", "1Y"] },
            risk_weights_ref: "girr_delta_weights",
            intra_bucket_correlation_ref: "girr_rho_kl",
            cross_bucket_correlation_ref: "girr_gamma_bc",
          },
          EQUITY: {
            dimensions: [], buckets: { naming: "equity_bucket", values: ["1"] },
            risk_weights_ref: "equity_weights",
            intra_bucket_correlation_ref: "equity_rho",
            cross_bucket_correlation_ref: "equity_gamma",
          },
          FX: {
            dimensions: [], buckets: { naming: "fx_pair_bucket", values: ["EURUSD"] },
            risk_weights_ref: "fx_weights",
            intra_bucket_correlation_ref: "fx_rho",
            cross_bucket_correlation_ref: "fx_gamma",
          },
        },
        risk_weights: {
          girr_delta_weights: { by_tenor: { "3M": 0.017, "6M": 0.017, "1Y": 0.016 } },
          equity_weights: { by_bucket: { "1": 0.55 } },
          fx_weights: { constant: 0.075 },
        },
        correlations: {
          girr_rho_kl: { kind: "constant", value: 0 },
          girr_vega_rho_kl: { kind: "constant", value: 0 },
          equity_rho: { kind: "constant", value: 0.5 },
          fx_rho: { kind: "constant", value: 0 },
        },
      } as unknown as Parameters<typeof createServer>[0]["schema"];
    }

    // Helper: build a fast-path FT.AGGREGATE reply for one bucket with the
    // alias keys the helper expects. RESP2 flat key/value row shape.
    function ftAggRow(bucket: string, kv: Record<string, number | string>): unknown[] {
      const row: unknown[] = ["bucket", bucket];
      for (const [k, v] of Object.entries(kv)) row.push(k, String(v));
      return row;
    }

    it("Equity Delta: single FT.AGGREGATE drives K_b via the constant-ρ closed form (γ=0)", async () => {
      // ρ=0.5; sumWs=10, sumWsSq=50 → K_b² = 50 + 0.5·(100−50) = 75 → K_b = √75.
      // γ=0 (no Equity entry in opts.correlations) → charge = K_b = √75.
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        // Two FT.AGGREGATEs land here: the discovery call (groupby @bucket,
        // count-only) AND the fast-path call (groupby + per-leg reducers).
        // Discovery: no APPLY clause; fast-path: APPLY present.
        const hasApply = args.includes("APPLY");
        if (!hasApply) return ftAggregateReply(["1"]);
        return [
          1,
          ftAggRow("1", {
            sum_d_ws_equity_delta: 10,
            sum_d_ws_equity_delta_sq: 50,
            row_count: 5,
          }),
        ];
      });
      app = await createServer({ redis: fr, schema: fastPathSchema() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "Equity", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.charge).toBeCloseTo(Math.sqrt(75), 9);
      expect(body.engine).toBe("ft_aggregate");
      expect(body.per_bucket).toHaveLength(1);
      expect(body.per_bucket[0]).toMatchObject({
        bucket: "1",
        K_b: expect.any(Number),
        S_b: 10,
        count: 5,
        engine: "ft_aggregate",
      });
      expect(body.per_bucket[0].K_b).toBeCloseTo(Math.sqrt(75), 9);
      // No FCALL was issued — fast path is single-FT.AGGREGATE end-to-end.
      expect(fr.calls.find((c) => c.command === "FCALL")).toBeUndefined();
    });

    // Wave 5.96A — per-bucket K_b drilldown. The route surfaces the
    // intermediates the closed-form K_b consumes (Σ WS², ρ·cross term) plus
    // a copy-pasteable FT.AGGREGATE / FCALL string per bucket so the UI can
    // render "How K_b was calculated" + "Redis · N ms" without re-deriving
    // anything client-side. Fast path populates the full breakdown; Lua path
    // stamps `path: "lua"` and omits the intermediates (intermediates are
    // computed inside the kernel and not surfaced — option B).
    describe("Wave 5.96A: per-bucket K_b drilldown", () => {
      it("Equity Delta fast path: intermediate.{ws_squared_sum, cross_term, path} + resolved_command", async () => {
        // ρ=0.5, sumWs=10, sumWsSq=50 → cross = 0.5·(100−50) = 25, K_b² = 75.
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
          if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
          return [
            1,
            ftAggRow("1", { sum_d_ws_equity_delta: 10, sum_d_ws_equity_delta_sq: 50, row_count: 5 }),
          ];
        });
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Delta" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        expect(pb.intermediate).toMatchObject({ path: "fast" });
        expect(pb.intermediate.ws_squared_sum).toBeCloseTo(50, 9);
        expect(pb.intermediate.cross_term).toBeCloseTo(25, 9);
        // resolved_command renders the per-bucket FT.AGGREGATE slice — must
        // carry the index name, the @bucket TAG predicate for THIS bucket,
        // and the per-class APPLY pipeline.
        expect(typeof pb.resolved_command).toBe("string");
        expect(pb.resolved_command).toMatch(/^FT\.AGGREGATE /);
        expect(pb.resolved_command).toContain("idx:sens");
        expect(pb.resolved_command).toContain("@bucket:{1}");
        expect(pb.resolved_command).toContain("APPLY");
      });

      it("Equity Vega fast path: intermediates + resolved_command for the vega leg", async () => {
        // ρ=0.5, single bucket: sumWs=6, sumWsSq=20 → cross = 0.5·(36−20)=8.
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
          if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
          return [
            1,
            ftAggRow("1", { sum_v_ws_equity_vega: 6, sum_v_ws_equity_vega_sq: 20, row_count: 3 }),
          ];
        });
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Vega" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        expect(pb.intermediate).toMatchObject({ path: "fast" });
        expect(pb.intermediate.ws_squared_sum).toBeCloseTo(20, 9);
        expect(pb.intermediate.cross_term).toBeCloseTo(8, 9);
        expect(pb.resolved_command).toContain("@sensitivity_type:{Vega}");
      });

      it("Equity Curvature fast path: surfaces K_b^+ / K_b^- and the winner label", async () => {
        // Same canned aggregates as the Wave 5.83C-1 curvature test:
        // up wins with K_b² = 14.5, down has K_b² = 4.5.
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
          if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
          return [
            1,
            ftAggRow("1", {
              sum_u_ws_equity_cvr_up: 4, sum_u_ws_equity_cvr_up_sq: 14,
              sum_u_ws_equity_cvr_up_neg: -1, sum_u_ws_equity_cvr_up_negsq: 1,
              sum_n_ws_equity_cvr_down: 3, sum_n_ws_equity_cvr_down_sq: 3,
              sum_n_ws_equity_cvr_down_neg: 0, sum_n_ws_equity_cvr_down_negsq: 0,
              row_count: 3,
            }),
          ];
        });
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Curvature" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        expect(pb.intermediate).toMatchObject({ path: "fast", curvature: { winner: "plus" } });
        expect(pb.intermediate.curvature.k_plus).toBeCloseTo(Math.sqrt(14.5), 9);
        expect(pb.intermediate.curvature.k_minus).toBeCloseTo(Math.sqrt(4.5), 9);
        // K_b² (winner) = 14.5 = ΣCVR² (14) + cross_term (0.5).
        expect(pb.intermediate.ws_squared_sum).toBeCloseTo(14, 9);
        expect(pb.intermediate.cross_term).toBeCloseTo(0.5, 9);
        expect(pb.resolved_command).toContain("@sensitivity_type:{Curvature}");
      });

      it("Lua path: intermediate.path='lua' with no breakdown + FCALL resolved_command", async () => {
        process.env.CALC_FAST_PATH = "0";
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", ftAggregateReply(["1"]));
        fr.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "5", "ms", "1"]);
        app = await createServer({
          redis: fr,
          schema: fastPathSchema(),
          correlations: { EQUITY: { kind: "constant", value: 0 } },
        });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Delta" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        expect(pb.intermediate).toEqual({ path: "lua" });
        expect(pb.intermediate.ws_squared_sum).toBeUndefined();
        expect(pb.intermediate.cross_term).toBeUndefined();
        expect(pb.resolved_command).toMatch(/^FCALL equity_delta 1 sens:\{EQUITY:1\}:_route EQUITY 1/);
      });
    });

    it("CALC_FAST_PATH=0 reverts to the Lua FCALL path and tags engine=fcall_lua", async () => {
      process.env.CALC_FAST_PATH = "0";
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", ftAggregateReply(["1"]));
      fr.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "5", "ms", "1"]);
      app = await createServer({
        redis: fr,
        schema: fastPathSchema(),
        correlations: { EQUITY: { kind: "constant", value: 0 } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "Equity", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.engine).toBe("fcall_lua");
      expect(body.per_bucket[0].engine).toBe("fcall_lua");
      // FCALL fired in the legacy path.
      expect(fr.calls.find((c) => c.command === "FCALL")).toBeDefined();
    });

    it("Wave 5.41 TIMEOUT clause preserved on the fast-path FT.AGGREGATE", async () => {
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
        return [1, ftAggRow("1", { sum_d_ws_equity_delta: 0, sum_d_ws_equity_delta_sq: 0, row_count: 1 })];
      });
      app = await createServer({ redis: fr, schema: fastPathSchema() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "Equity", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      // The fast-path FT.AGGREGATE (the one carrying APPLY) must include
      // TIMEOUT 30000 in its arg list so a slow cluster surfaces as a 502
      // instead of an indefinite hang.
      const fastCall = fr.calls.find(
        (c) => c.command === "FT.AGGREGATE" && c.args.includes("APPLY"),
      );
      expect(fastCall).toBeDefined();
      const ti = fastCall!.args.indexOf("TIMEOUT");
      expect(ti).toBeGreaterThan(-1);
      expect(fastCall!.args[ti + 1]).toBe("30000");
    });

    it("GIRR Delta per-tenor: K_b uses per-tenor sums (not per-row squared sums)", async () => {
      // 3 tenors with per-tenor sums [3, 4, 0] → sumWs=7, sumWsSq=9+16=25.
      // ρ=0 → K_b² = 25; K_b = 5.
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftAggregateReply(["USD"]);
        return [
          1,
          ftAggRow("USD", {
            sum_d_ws_girr_delta_3M: 3,
            sum_d_ws_girr_delta_3M_sq: 999,  // unused — Delta path squares per-tenor SUMS
            sum_d_ws_girr_delta_6M: 4,
            sum_d_ws_girr_delta_6M_sq: 999,
            sum_d_ws_girr_delta_1Y: 0,
            sum_d_ws_girr_delta_1Y_sq: 999,
            row_count: 7,
          }),
        ];
      });
      app = await createServer({ redis: fr, schema: fastPathSchema() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.per_bucket[0].K_b).toBeCloseTo(5, 9);
      expect(body.per_bucket[0].S_b).toBeCloseTo(7, 9);
      expect(body.per_bucket[0].count).toBe(7);
    });

    it("Equity Curvature scalar: sign-split aggregates reproduce the §21.5(3) ψ-gated K_b", async () => {
      // up = [2, 3, -1] (a 3-row bucket). S=4, SQ=4+9+1=14, N=-1, SQN=1.
      // totalCross = 16-14 = 2; negCross = 1-1 = 0; gated = 2.
      // ρ_curv = 0.5² = 0.25; K_b_up² = 14 + 0.25·2 = 14.5 → K_b_up = √14.5.
      // down all-positive: e.g. [1, 1, 1] → S=3, SQ=3, totalCross=6, neg=0.
      // K_b_down² = 3 + 0.25·6 = 4.5 → K_b_down = √4.5.
      // K_b = max = √14.5 (up wins); S_b = 4 (up sum).
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
        return [
          1,
          ftAggRow("1", {
            sum_u_ws_equity_cvr_up: 4,
            sum_u_ws_equity_cvr_up_sq: 14,
            sum_u_ws_equity_cvr_up_neg: -1,
            sum_u_ws_equity_cvr_up_negsq: 1,
            sum_n_ws_equity_cvr_down: 3,
            sum_n_ws_equity_cvr_down_sq: 3,
            sum_n_ws_equity_cvr_down_neg: 0,
            sum_n_ws_equity_cvr_down_negsq: 0,
            row_count: 3,
          }),
        ];
      });
      app = await createServer({ redis: fr, schema: fastPathSchema() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "Equity", sensitivity_type: "Curvature" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.per_bucket[0].K_b).toBeCloseTo(Math.sqrt(14.5), 9);
      expect(body.per_bucket[0].S_b).toBeCloseTo(4, 9);
      expect(body.per_bucket[0].count).toBe(3);
      // Single-bucket γ=0 reduce → charge = K_b.
      expect(body.charge).toBeCloseTo(Math.sqrt(14.5), 9);
      expect(body.curvature_branch).toBe("positive_interior");
    });

    // Wave 5.83B-fix — parity proofs for the per-leg weighting rule. Each test
    // drives raw rows through enrichDoc, aggregates the resulting weighted_*
    // fields exactly as FT.AGGREGATE would on the index, and asserts the
    // fast-path K_b matches the Lua reference closed form within 1e-9. Because
    // bootstrap.ts loads equity_vega / fx_vega with w=1.0 and *_curvature.lua
    // applies no weight at all, the Lua reference reduces to the same constant-ρ
    // (Vega) or ψ-gated (Curvature) formula the fast path uses — but ONLY when
    // enrichDoc's pre-weighting is identity for those legs, which is what the
    // 5.83B-fix delivered.
    it("Equity Vega parity: enrichDoc + fast path matches Lua w=1.0 closed form", async () => {
      const schema = fastPathSchema() as any;
      const rho = schema.correlations.equity_rho.value;  // 0.5
      // Raw vega sensitivities — mix signs so the cross term exercises both branches.
      const rows = [0.10, 0.20, -0.05, 0.30, 0.15].map((spot) => ({
        risk_class: "EQUITY", bucket: "1", sensitivity_type: "Vega", risk_value: { spot },
      }));
      // Aggregate enrichDoc's weighted_value as the index would (SUM, SUM(sq)).
      let sumWs = 0, sumWsSq = 0;
      for (const r of rows) {
        const wv = enrichDoc(r, schema as any).weighted_value as number;
        sumWs += wv; sumWsSq += wv * wv;
      }
      // Lua reference (w=1.0 hardcoded in bootstrap.ts for equity_vega):
      //   WS_k = 1.0 · s_k → S, SQ identical to the aggregates above.
      let refS = 0, refSQ = 0;
      for (const r of rows) {
        const s = (r.risk_value as { spot: number }).spot;
        refS += 1.0 * s; refSQ += (1.0 * s) ** 2;
      }
      const refKbSq = refSQ + rho * Math.max(0, refS * refS - refSQ);
      const refKb = Math.sqrt(Math.max(0, refKbSq));

      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
        return [1, ftAggRow("1", {
          sum_v_ws_equity_vega: sumWs,
          sum_v_ws_equity_vega_sq: sumWsSq,
          row_count: rows.length,
        })];
      });
      app = await createServer({ redis: fr, schema });
      const res = await app.inject({
        method: "POST", url: "/calc/sbm",
        payload: { risk_class: "Equity", sensitivity_type: "Vega" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.engine).toBe("ft_aggregate");
      // Parity gate: ≤1e-9 between fast-path K_b and Lua w=1.0 closed form.
      expect(Math.abs(body.per_bucket[0].K_b - refKb)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(body.per_bucket[0].S_b - refS)).toBeLessThanOrEqual(1e-9);
    });

    it("Equity Curvature parity: enrichDoc + fast path matches §21.5(3) ψ-gated reference", async () => {
      const schema = fastPathSchema() as any;
      const rhoDelta = schema.correlations.equity_rho.value;  // 0.5
      const rhoCurv = rhoDelta * rhoDelta;                    // 0.25 per §21.5(3)
      // Raw CVR pairs — mix signs so ψ-gate actually drops cross terms.
      const rows = [
        { cvr_up:  0.40, cvr_down:  0.10 },
        { cvr_up: -0.30, cvr_down:  0.20 },
        { cvr_up:  0.50, cvr_down: -0.15 },
        { cvr_up: -0.10, cvr_down: -0.25 },
        { cvr_up:  0.20, cvr_down:  0.05 },
      ].map((rv) => ({
        risk_class: "EQUITY", bucket: "1", sensitivity_type: "Curvature", risk_value: rv,
      }));
      // Aggregate enrichDoc's weighted_cvr_* values as the index would. Sign-
      // split aggregates mirror buildFastPathAggregateArgs (u/n prefix groups).
      const acc = { uS: 0, uSQ: 0, uN: 0, uSQN: 0, dS: 0, dSQ: 0, dN: 0, dSQN: 0 };
      for (const r of rows) {
        const e = enrichDoc(r, schema as any);
        const u = e.weighted_cvr_up as number; const d = e.weighted_cvr_down as number;
        acc.uS += u; acc.uSQ += u * u; acc.uN += u < 0 ? u : 0; acc.uSQN += u < 0 ? u * u : 0;
        acc.dS += d; acc.dSQ += d * d; acc.dN += d < 0 ? d : 0; acc.dSQN += d < 0 ? d * d : 0;
      }
      // Lua reference: with no weight applied (equity_curvature.lua passes raw
      // CVR), §21.5(3) collapses to the same ψ-gated cross the fast-path
      // sign-split closed form recovers from the per-bucket aggregates.
      const refDir = (S: number, SQ: number, N: number, SQN: number) => {
        const totalCross = S * S - SQ; const negCross = N * N - SQN;
        const kbSq = Math.max(0, SQ + rhoCurv * (totalCross - negCross));
        return { K_b: Math.sqrt(kbSq), S_b: S };
      };
      const up = refDir(acc.uS, acc.uSQ, acc.uN, acc.uSQN);
      const dn = refDir(acc.dS, acc.dSQ, acc.dN, acc.dSQN);
      const winner = dn.K_b > up.K_b ? dn : up;

      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
        return [1, ftAggRow("1", {
          sum_u_ws_equity_cvr_up: acc.uS,
          sum_u_ws_equity_cvr_up_sq: acc.uSQ,
          sum_u_ws_equity_cvr_up_neg: acc.uN,
          sum_u_ws_equity_cvr_up_negsq: acc.uSQN,
          sum_n_ws_equity_cvr_down: acc.dS,
          sum_n_ws_equity_cvr_down_sq: acc.dSQ,
          sum_n_ws_equity_cvr_down_neg: acc.dN,
          sum_n_ws_equity_cvr_down_negsq: acc.dSQN,
          row_count: rows.length,
        })];
      });
      app = await createServer({ redis: fr, schema });
      const res = await app.inject({
        method: "POST", url: "/calc/sbm",
        payload: { risk_class: "Equity", sensitivity_type: "Curvature" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.engine).toBe("ft_aggregate");
      expect(Math.abs(body.per_bucket[0].K_b - winner.K_b)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(body.per_bucket[0].S_b - winner.S_b)).toBeLessThanOrEqual(1e-9);
    });

    // Wave 5.96A.1 — per-bucket K_b component breakdown: ws_components,
    // cross_components (top 10 + truncated flag), cvr_components for curvature,
    // plus the bucket-cross-detail endpoint for the full pair list.
    describe("Wave 5.96A.1: per-component breakdown", () => {
      // Per-RF FT.AGGREGATE reply shape: rows of (bucket, risk_factor, sums).
      function perRfRow(bucket: string, rf: string, kv: Record<string, number | string>): unknown[] {
        const row: unknown[] = ["bucket", bucket, "risk_factor", rf];
        for (const [k, v] of Object.entries(kv)) row.push(k, String(v));
        return row;
      }
      // FT.AGGREGATE dispatch helper that routes between discovery, main fast-
      // path, and per-RF components aggregate via args inspection.
      function routeFtAggregate(replies: {
        discovery: (args: unknown[]) => unknown;
        main: (args: unknown[]) => unknown;
        perRf: (args: unknown[]) => unknown;
      }) {
        return (args: unknown[]) => {
          if (!args.includes("APPLY")) return replies.discovery(args);
          if (args.includes("@risk_factor")) return replies.perRf(args);
          return replies.main(args);
        };
      }

      it("GIRR Delta perTenor: ws_components match per-tenor sums; Σ ws_squared = ws_squared_sum", async () => {
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", routeFtAggregate({
          discovery: () => ftAggregateReply(["USD"]),
          main: () => [1, ftAggRow("USD", {
            sum_d_ws_girr_delta_3M: 3,
            sum_d_ws_girr_delta_6M: 4,
            sum_d_ws_girr_delta_1Y: 0,
            row_count: 7,
          })],
          perRf: () => [0],  // unused for GIRR perTenor
        }));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        const ws = pb.intermediate.ws_components;
        expect(Array.isArray(ws)).toBe(true);
        // Component count matches tenor count from schema (3M, 6M, 1Y).
        expect(ws.length).toBe(3);
        const sumWsSq = ws.reduce((acc: number, c: { ws_squared: number }) => acc + c.ws_squared, 0);
        expect(Math.abs(sumWsSq - pb.intermediate.ws_squared_sum)).toBeLessThanOrEqual(1e-9);
      });

      it("Equity Delta scalar: per-RF aggregate populates ws_components with Σ ws_squared = ws_squared_sum", async () => {
        // 3 RFs in bucket "1" with WS sums [2, 3, -1] and squared sums [4, 9, 1].
        // ws_squared_sum (main aggregate) = 4 + 9 + 1 = 14.
        // sumWs (main) = 2 + 3 - 1 = 4 → cross_term = 0.5·(16-14) = 1; K_b² = 15.
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", routeFtAggregate({
          discovery: () => ftAggregateReply(["1"]),
          main: () => [1, ftAggRow("1", {
            sum_d_ws_equity_delta: 4,
            sum_d_ws_equity_delta_sq: 14,
            row_count: 3,
          })],
          perRf: () => [
            3,
            perRfRow("1", "AAPL", { sum_d_ws_equity_delta: 2, sum_d_ws_equity_delta_sq: 4 }),
            perRfRow("1", "GOOG", { sum_d_ws_equity_delta: 3, sum_d_ws_equity_delta_sq: 9 }),
            perRfRow("1", "MSFT", { sum_d_ws_equity_delta: -1, sum_d_ws_equity_delta_sq: 1 }),
          ],
        }));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Delta" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        const ws = pb.intermediate.ws_components;
        expect(ws.length).toBe(3);
        const sumWsSq = ws.reduce((acc: number, c: { ws_squared: number }) => acc + c.ws_squared, 0);
        expect(Math.abs(sumWsSq - pb.intermediate.ws_squared_sum)).toBeLessThanOrEqual(1e-9);
        const keys = ws.map((c: { k: string }) => c.k).sort();
        expect(keys).toEqual(["AAPL", "GOOG", "MSFT"]);
      });

      it("Equity Vega scalar: ws_components populated via per-RF aggregate", async () => {
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", routeFtAggregate({
          discovery: () => ftAggregateReply(["1"]),
          main: () => [1, ftAggRow("1", {
            sum_v_ws_equity_vega: 6, sum_v_ws_equity_vega_sq: 20, row_count: 3,
          })],
          perRf: () => [
            2,
            perRfRow("1", "AAPL", { sum_v_ws_equity_vega: 4, sum_v_ws_equity_vega_sq: 16 }),
            perRfRow("1", "MSFT", { sum_v_ws_equity_vega: 2, sum_v_ws_equity_vega_sq: 4 }),
          ],
        }));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Vega" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        const ws = pb.intermediate.ws_components;
        expect(ws.length).toBe(2);
        const sumWsSq = ws.reduce((acc: number, c: { ws_squared: number }) => acc + c.ws_squared, 0);
        expect(Math.abs(sumWsSq - pb.intermediate.ws_squared_sum)).toBeLessThanOrEqual(1e-9);
      });

      it("cross_components sorted by descending |contrib| with length ≤ 10 and truncated flag set when > 10", async () => {
        // 12 RFs with monotonically increasing WS so |contrib| ordering is
        // predictable. With WS_i = i+1 for i=0..11 (so [1,2,3,4,5,6,7,8,9,10,11,12])
        // and ρ=0.5, the biggest contribs are 0.5·11·12 (and 0.5·12·11) = 66.
        const N = 12;
        const ws = Array.from({ length: N }, (_, i) => i + 1);
        const sumWs = ws.reduce((a, b) => a + b, 0);
        const sumWsSq = ws.reduce((a, b) => a + b * b, 0);
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", routeFtAggregate({
          discovery: () => ftAggregateReply(["1"]),
          main: () => [1, ftAggRow("1", {
            sum_d_ws_equity_delta: sumWs, sum_d_ws_equity_delta_sq: sumWsSq, row_count: N,
          })],
          perRf: () => {
            const rows: unknown[] = [N];
            for (let i = 0; i < N; i++) {
              rows.push(perRfRow("1", `RF${String(i).padStart(2, "0")}`, {
                sum_d_ws_equity_delta: ws[i]!,
                sum_d_ws_equity_delta_sq: ws[i]! * ws[i]!,
              }));
            }
            return rows;
          },
        }));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Delta" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        const cc = pb.intermediate.cross_components;
        expect(cc.length).toBe(10);
        expect(pb.intermediate.cross_components_truncated).toBe(true);
        expect(pb.intermediate.cross_components_total_count).toBe(N * (N - 1));
        // Sorted descending by |contrib|.
        for (let i = 1; i < cc.length; i++) {
          expect(Math.abs(cc[i - 1].contrib)).toBeGreaterThanOrEqual(Math.abs(cc[i].contrib));
        }
        // Top pair must be RF10/RF11 (or its mirror) with contrib = 0.5·11·12 = 66.
        expect(Math.abs(cc[0].contrib)).toBeCloseTo(0.5 * 11 * 12, 9);
      });

      it("cross_components_truncated is false when total pair count ≤ 10", async () => {
        // 3 RFs → 6 ordered pairs ≤ 10 → not truncated.
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", routeFtAggregate({
          discovery: () => ftAggregateReply(["1"]),
          main: () => [1, ftAggRow("1", {
            sum_d_ws_equity_delta: 4, sum_d_ws_equity_delta_sq: 14, row_count: 3,
          })],
          perRf: () => [
            3,
            perRfRow("1", "AAPL", { sum_d_ws_equity_delta: 2, sum_d_ws_equity_delta_sq: 4 }),
            perRfRow("1", "GOOG", { sum_d_ws_equity_delta: 3, sum_d_ws_equity_delta_sq: 9 }),
            perRfRow("1", "MSFT", { sum_d_ws_equity_delta: -1, sum_d_ws_equity_delta_sq: 1 }),
          ],
        }));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Delta" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        expect(pb.intermediate.cross_components.length).toBe(6);
        expect(pb.intermediate.cross_components_truncated).toBe(false);
        expect(pb.intermediate.cross_components_total_count).toBe(6);
      });

      it("Curvature Equity scalar: cvr_components populated via per-RF aggregate", async () => {
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", routeFtAggregate({
          discovery: () => ftAggregateReply(["1"]),
          main: () => [1, ftAggRow("1", {
            sum_u_ws_equity_cvr_up: 4, sum_u_ws_equity_cvr_up_sq: 14,
            sum_u_ws_equity_cvr_up_neg: -1, sum_u_ws_equity_cvr_up_negsq: 1,
            sum_n_ws_equity_cvr_down: 3, sum_n_ws_equity_cvr_down_sq: 3,
            sum_n_ws_equity_cvr_down_neg: 0, sum_n_ws_equity_cvr_down_negsq: 0,
            row_count: 3,
          })],
          perRf: () => [
            3,
            perRfRow("1", "AAPL", {
              sum_u_ws_equity_cvr_up: 2, sum_u_ws_equity_cvr_up_sq: 4,
              sum_n_ws_equity_cvr_down: 1, sum_n_ws_equity_cvr_down_sq: 1,
            }),
            perRfRow("1", "GOOG", {
              sum_u_ws_equity_cvr_up: 3, sum_u_ws_equity_cvr_up_sq: 9,
              sum_n_ws_equity_cvr_down: 1, sum_n_ws_equity_cvr_down_sq: 1,
            }),
            perRfRow("1", "MSFT", {
              sum_u_ws_equity_cvr_up: -1, sum_u_ws_equity_cvr_up_sq: 1,
              sum_n_ws_equity_cvr_down: 1, sum_n_ws_equity_cvr_down_sq: 1,
            }),
          ],
        }));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "Equity", sensitivity_type: "Curvature" },
        });
        expect(res.statusCode).toBe(200);
        const pb = res.json().per_bucket[0];
        const cvr = pb.intermediate.curvature.cvr_components;
        expect(Array.isArray(cvr)).toBe(true);
        expect(cvr.length).toBe(3);
        // Σ cvr_up = 4 (matches the main-aggregate K_b^+ precursor).
        const sumUp = cvr.reduce((a: number, c: { cvr_up: number }) => a + c.cvr_up, 0);
        const sumDown = cvr.reduce((a: number, c: { cvr_down: number }) => a + c.cvr_down, 0);
        expect(Math.abs(sumUp - 4)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(sumDown - 3)).toBeLessThanOrEqual(1e-9);
      });

      it("POST /calc/sbm/bucket-cross-detail returns all cross_components for the requested bucket", async () => {
        const N = 5;
        const ws = [1, 2, 3, 4, 5];
        const sumWs = ws.reduce((a, b) => a + b, 0);
        const sumWsSq = ws.reduce((a, b) => a + b * b, 0);
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", routeFtAggregate({
          discovery: () => ftAggregateReply(["1"]),
          main: () => [1, ftAggRow("1", {
            sum_d_ws_equity_delta: sumWs, sum_d_ws_equity_delta_sq: sumWsSq, row_count: N,
          })],
          perRf: () => {
            const rows: unknown[] = [N];
            for (let i = 0; i < N; i++) {
              rows.push(perRfRow("1", `RF${i}`, {
                sum_d_ws_equity_delta: ws[i]!,
                sum_d_ws_equity_delta_sq: ws[i]! * ws[i]!,
              }));
            }
            return rows;
          },
        }));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm/bucket-cross-detail",
          payload: { risk_class: "Equity", sensitivity_type: "Delta", bucket: "1" },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.bucket).toBe("1");
        // N=5 → 20 ordered pairs returned in full (no truncation).
        expect(body.cross_components.length).toBe(N * (N - 1));
        // Sorted descending by |contrib|.
        for (let i = 1; i < body.cross_components.length; i++) {
          expect(Math.abs(body.cross_components[i - 1].contrib))
            .toBeGreaterThanOrEqual(Math.abs(body.cross_components[i].contrib));
        }
      });

      it("POST /calc/sbm/bucket-cross-detail rejects missing bucket", async () => {
        const fr = fakeRedis();
        fr.setResponse("FT.AGGREGATE", () => ftAggregateReply([]));
        app = await createServer({ redis: fr, schema: fastPathSchema() });
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm/bucket-cross-detail",
          payload: { risk_class: "Equity", sensitivity_type: "Delta" },
        });
        expect(res.statusCode).toBe(400);
      });
    });

    it("commands.fcall.dispatched_keys still mirrors the per-bucket key shape on the fast path", async () => {
      // Stability gate: the UI commands panel keys off this list. Fast path
      // didn't actually issue the FCALLs, but the keys describe what the
      // legacy path WOULD have dispatched for the same input.
      const fr = fakeRedis();
      fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftAggregateReply(["1"]);
        return [1, ftAggRow("1", { sum_d_ws_equity_delta: 0, sum_d_ws_equity_delta_sq: 0, row_count: 1 })];
      });
      app = await createServer({ redis: fr, schema: fastPathSchema() });
      const res = await app.inject({
        method: "POST",
        url: "/calc/sbm",
        payload: { risk_class: "Equity", sensitivity_type: "Delta" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.commands.fcall.dispatched_keys).toEqual(["sens:{EQUITY:1}:_route"]);
    });
  });
});

// Wave 5.96F — truthful timing on cache hits. The cached body's `total_ms`
// holds the cold-compute cost; replaying it on every warm retry made Redis
// caching look slow (the UI surfaced "Computed in 21 s" alongside cache:hit).
// computeSbmCharge now overwrites `total_ms` with the freshly-measured hit
// elapsed and preserves the cold value as `original_compute_ms` so the
// headline chip can render "Computed in 21.05 s (cached, served in 12 ms)".
describe("POST /calc/sbm — Wave 5.96F truthful cache-hit timing", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetCalcCacheForTests();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("cold call records cache:miss with no original_compute_ms; warm call records cache:hit with fresh total_ms and preserved original_compute_ms", async () => {
    // Synthetic 50 ms latency on the Redis ops so the cold response has a
    // realistically slow `total_ms` (≥50 ms). The warm retry must come in
    // far faster because no FT.AGGREGATE / FCALL is dispatched — only the
    // in-process cache lookup runs.
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return ftAggregateReply(["USD-IRS"]);
    });
    fr.setResponse("FCALL", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return ["K_b", "3", "S_b", "3", "count", "100", "ms", "5"];
    });
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const cold = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(cold.statusCode).toBe(200);
    const coldBody = cold.json();
    expect(coldBody.cache).toBe("miss");
    expect(coldBody.original_compute_ms).toBeUndefined();
    expect(coldBody.total_ms).toBeGreaterThanOrEqual(50);
    const coldTotalMs = Number(coldBody.total_ms);

    // Warm retry hits the cache; total_ms must reflect the fresh lookup
    // (well under any plausible cold-compute cost) while original_compute_ms
    // exactly preserves the cold-compute value.
    const warm = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(warm.statusCode).toBe(200);
    const warmBody = warm.json();
    expect(warmBody.cache).toBe("hit");
    expect(warmBody.original_compute_ms).toBe(coldTotalMs);
    expect(warmBody.total_ms).toBeLessThan(200);
    expect(warmBody.total_ms).toBeLessThan(coldTotalMs);
    expect(warmBody.fanout_ms).toBe(0);
    expect(warmBody.original_fanout_ms).toBe(coldBody.fanout_ms);
    // The charge itself is unchanged on warm replay — only the timing
    // metadata is freshly measured.
    expect(warmBody.charge).toBe(coldBody.charge);
  });

  it("?nocache=1 skips the cache and never reports cache:hit", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "100", "ms", "1"]);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const r1 = await app.inject({
      method: "POST",
      url: "/calc/sbm?nocache=1",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/calc/sbm?nocache=1",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(r1.json().cache).toBe("miss");
    expect(r2.json().cache).toBe("miss");
    expect(r1.json().original_compute_ms).toBeUndefined();
    expect(r2.json().original_compute_ms).toBeUndefined();
  });
});
