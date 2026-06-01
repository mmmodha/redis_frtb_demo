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
      // Routing: every FCALL hits the curvature function for this risk class.
      const fcalls = fr.calls.filter((c) => c.command === "FCALL");
      expect(fcalls).toHaveLength(2);
      for (const c of fcalls) {
        expect(c.args[0]).toBe(funcName);
        expect(String(c.args[2])).toMatch(/^sens:\{[A-Z]+:[^}]+\}:_route$/);
      }
    },
  );

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
});
