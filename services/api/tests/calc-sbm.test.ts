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
});
