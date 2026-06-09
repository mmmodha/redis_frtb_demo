import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { __resetCalcCacheForTests } from "../src/sbm/calc-cache.ts";

// Wave 5.96B — Total SBM orchestrator tests.
//
// The orchestrator fans out computeSbmCharge across the 27-cell matrix
// (3 classes × 3 legs × 3 scenarios) in parallel via Promise.all, then
// collapses per-scenario via Σ_class (Δ + V + Crv) and takes max over
// low/medium/high. These tests assert the response shape, the parallelism
// evidence (cumulative_ms / wall_clock_ms > 2.0), the no-data-or-index
// per-cell skip path, and the validation surface mirroring /calc/sbm.

function ftAggregateReply(buckets: string[]) {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}

// Per-cell delayed Redis stub. Each FT.AGGREGATE / FCALL response is held
// for `delayMs` milliseconds so the orchestrator can demonstrate measurable
// parallelism — without the delay the fake responses resolve synchronously
// on the next microtask and cumulative_ms collapses to ~0.
function delayedFakeRedis(delayMs: number, buckets: string[]) {
  const fr = fakeRedis();
  fr.setResponse("FT.AGGREGATE", async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return ftAggregateReply(buckets);
  });
  fr.setResponse("FCALL", async (args: unknown[]) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const bucket = String(args[4]);
    return ["K_b", "3", "S_b", "3", "count", "100", "ms", "5", "_b", bucket];
  });
  fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "1000"]);
  // Wrap the original call to also await the delay (handler-level async
  // already does this; this exists so the route's other Redis ops don't
  // throw "no response set" for commands we haven't stubbed).
  return fr;
}

describe("POST /calc/sbm/total — Wave 5.96B orchestrator", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => {
    __resetCalcCacheForTests();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns the 27-cell breakdown shape and the locked metadata fields", async () => {
    const fr = delayedFakeRedis(0, ["USD-IRS"]);
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
    const body = res.json();
    expect(body.unsupported_classes).toEqual([
      "csr_non_sec", "csr_sec_non_ctp", "csr_sec_ctp", "commodity",
    ]);
    // breakdown carries one entry per (class, leg) — 3 × 3 = 9 rows
    expect(body.breakdown).toHaveLength(9);
    expect(body.performance.redis_ops_count + body.performance.ops_skipped).toBe(27);
    expect(["low", "medium", "high"]).toContain(body.winning_scenario);
    expect(typeof body.resolved_command_summary).toBe("string");
    for (const s of ["low", "medium", "high"]) {
      expect(typeof body.scenario_totals[s]).toBe("number");
    }
    // every (class, leg) entry carries the three scenarios with {charge, ms}
    for (const entry of body.breakdown) {
      expect(["GIRR", "EQUITY", "FX"]).toContain(entry.risk_class);
      expect(["delta", "vega", "curvature"]).toContain(entry.leg);
      expect(typeof entry.skipped).toBe("boolean");
      for (const s of ["low", "medium", "high"]) {
        expect(typeof entry.scenarios[s].charge).toBe("number");
        expect(typeof entry.scenarios[s].ms).toBe("number");
      }
    }
    const maxScenario = Math.max(
      body.scenario_totals.low,
      body.scenario_totals.medium,
      body.scenario_totals.high,
    );
    expect(body.total_sbm).toBeCloseTo(maxScenario, 10);
  });

  it("parallelism_factor > 2.0 when per-cell Redis ops have measurable latency", async () => {
    // 5 ms per Redis op × ~2 ops per cell × 27 cells = ~270 ms cumulative.
    // Wall-clock should stay well under that thanks to Promise.all fanout,
    // yielding a parallelism_factor solidly above 2.0.
    const fr = delayedFakeRedis(5, ["USD-IRS"]);
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
    const body = res.json();
    expect(body.performance.cumulative_ms).toBeGreaterThan(0);
    expect(body.performance.total_ms).toBeGreaterThan(0);
    expect(body.performance.parallelism_factor).toBeGreaterThan(2.0);
  });

  it("rejects malformed bucket_subset with 400 (mirrors /calc/sbm)", async () => {
    const fr = delayedFakeRedis(0, ["USD-IRS"]);
    app = await createServer({ redis: fr, correlations: {} });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/total",
      payload: { bucket_subset: [""] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/bucket_subset/);
  });

  it("rejects malformed exclude with 400 (mirrors /calc/sbm)", async () => {
    const fr = delayedFakeRedis(0, ["USD-IRS"]);
    app = await createServer({ redis: fr, correlations: {} });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/total",
      payload: { exclude: { book: ["with,comma"] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/exclude\.book/);
  });

  it("a 503 no-data-or-index cell is recorded as skipped with charge 0", async () => {
    const fr = fakeRedis();
    // Discovery returns empty → triggers the precondition probe.
    fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "0"]);
    app = await createServer({ redis: fr, correlations: {} });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm/total?nocache=1",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total_sbm).toBe(0);
    expect(body.performance.redis_ops_count).toBe(0);
    expect(body.performance.ops_skipped).toBe(27);
    expect(body.breakdown).toHaveLength(9);
    for (const entry of body.breakdown) {
      expect(entry.skipped).toBe(true);
      for (const s of ["low", "medium", "high"]) {
        expect(entry.scenarios[s].charge).toBe(0);
      }
    }
  });
});
