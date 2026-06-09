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

  // Wave 5.96F — truthful per-cell timing on cache hits. The orchestrator
  // previously stored each inner cell's `b.total_ms` as the displayed
  // per-cell ms; on a cache hit that replayed the cold-compute cost (often
  // 100×–1000× larger than the wall-clock elapsed of the warm fan-out),
  // breaking the math invariant max(cell_ms) ≤ wall_clock_ms and inflating
  // the parallelism factor into the millions. The fix is to use the
  // orchestrator's own freshly-measured `cell_ms` for the breakdown and
  // expose the stored cold cost as `original_compute_ms`.
  it("warm retry: per-cell ms ≤ wall_clock, parallelism_factor sane, original_compute_ms preserved", async () => {
    const fr = delayedFakeRedis(5, ["USD-IRS"]);
    app = await createServer({
      redis: fr,
      correlations: {
        GIRR: { kind: "constant", value: 0 },
        EQUITY: { kind: "constant", value: 0 },
        FX: { kind: "constant", value: 0 },
      },
    });
    // Cold run: every cell is computed and cached. cumulative_ms / total_ms
    // should both be in the realistic millisecond range for the fan-out.
    const cold = await app.inject({
      method: "POST",
      url: "/calc/sbm/total",
      payload: {},
    });
    expect(cold.statusCode).toBe(200);
    const coldBody = cold.json();
    expect(coldBody.performance.cache).toBe("miss");
    // Wall-clock invariant: no per-cell ms may exceed the wall-clock.
    for (const row of coldBody.breakdown) {
      for (const s of ["low", "medium", "high"]) {
        expect(row.scenarios[s].ms).toBeLessThanOrEqual(coldBody.performance.total_ms + 1);
      }
    }
    const coldCumulative = coldBody.performance.cumulative_ms;
    expect(coldCumulative).toBeGreaterThan(0);

    // Warm retry: every cell is a cache hit. The freshly-measured
    // per-cell ms must be far less than the cold-compute cost, and the
    // wall-clock invariant must still hold. `original_cumulative_ms`
    // preserves the cold reference; `parallelism_factor` lands in a sane
    // (e.g. <100×) range, NOT millions.
    const warm = await app.inject({
      method: "POST",
      url: "/calc/sbm/total",
      payload: {},
    });
    expect(warm.statusCode).toBe(200);
    const warmBody = warm.json();
    expect(warmBody.performance.cache).toBe("hit");
    expect(warmBody.performance.cache_hits).toBe(warmBody.performance.redis_ops_count);
    // Wall-clock invariant on the warm retry — this was the bug.
    let maxCellMs = 0;
    for (const row of warmBody.breakdown) {
      for (const s of ["low", "medium", "high"]) {
        const cellMs = row.scenarios[s].ms;
        expect(cellMs).toBeLessThanOrEqual(warmBody.performance.total_ms + 1);
        if (cellMs > maxCellMs) maxCellMs = cellMs;
        // On a non-skipped cell the original_compute_ms field must echo
        // the cold-compute cost. We only assert it's defined and at least
        // as large as the freshly-measured warm ms — the cold run's per-
        // cell ms exact value can't be deterministically mirrored back
        // through the shared cache, but it MUST be greater than the
        // warm-lookup elapsed.
        if (!row.skipped) {
          expect(typeof row.scenarios[s].original_compute_ms).toBe("number");
          expect(row.scenarios[s].original_compute_ms).toBeGreaterThanOrEqual(cellMs);
        }
      }
    }
    // cumulative_ms is now the sum of fresh cell_ms values, so the
    // wall-clock invariant generalises: cumulative_ms / wall_clock ≤
    // number of cells. parallelism_factor lands in a sane bound, NOT the
    // millions reported pre-fix.
    expect(warmBody.performance.cumulative_ms).toBeGreaterThanOrEqual(0);
    expect(warmBody.performance.parallelism_factor).toBeLessThan(100);
    expect(warmBody.performance.parallelism_factor).toBeGreaterThanOrEqual(0);
    // original_cumulative_ms preserves the cold reference (sum of inner
    // cold-compute costs). It must roughly match the cold cumulative.
    expect(typeof warmBody.performance.original_cumulative_ms).toBe("number");
    expect(warmBody.performance.original_cumulative_ms).toBeGreaterThanOrEqual(coldCumulative * 0.5);
    // Wave 5.96N — on a cache-hit run `original_parallelism_factor`
    // mirrors the Σ-if-serial chip's data source: it equals
    // `original_cumulative_ms / total_ms` so the perf strip can render
    // one coherent cold-vs-warm speedup story. On a cold run it equals
    // the legacy `parallelism_factor` because the two cumulatives match.
    expect(typeof warmBody.performance.original_parallelism_factor).toBe("number");
    const expectedWarm = warmBody.performance.original_cumulative_ms / warmBody.performance.total_ms;
    expect(warmBody.performance.original_parallelism_factor).toBeGreaterThan(0);
    const warmRatio = warmBody.performance.original_parallelism_factor / expectedWarm;
    expect(warmRatio).toBeGreaterThan(0.99);
    expect(warmRatio).toBeLessThan(1.01);
    // Cold run: original cumulative ≈ cumulative, so the two factors
    // line up to within ~5% (rounding + originalComputeMs vs cell_ms
    // accounting differ by at most timing noise on a fresh compute).
    expect(typeof coldBody.performance.original_parallelism_factor).toBe("number");
    const coldRatio = coldBody.performance.parallelism_factor > 0
      ? coldBody.performance.original_parallelism_factor / coldBody.performance.parallelism_factor
      : 1;
    expect(coldRatio).toBeGreaterThan(0.95);
    expect(coldRatio).toBeLessThan(1.05);
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
        // Wave 5.96G-api — skipped cells carry data_status 'skipped' so the
        // UI can tell them apart from real-zero ("empty") cells.
        expect(entry.scenarios[s].data_status).toBe("skipped");
      }
    }
    expect(body.performance.cells_empty).toBe(0);
  });

  // Wave 5.96G-api — per-cell data_status threading. When discovery DOES find
  // buckets but every kernel scan returns count=0 (the curvature-without-rows
  // case), the orchestrator must mark each affected scenarios[s] with
  // data_status='empty' and aggregate them into performance.cells_empty so
  // the UI can render a single "no data ingested" banner.
  it("populated cells with zero-row buckets land as data_status='empty' and bump cells_empty", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    // Every FCALL — across all 27 cells — returns count=0. The 27 cells split
    // into 9 (class, leg) rows × 3 scenarios; every scenario is "empty".
    fr.setResponse("FCALL", ["K_b", "0", "S_b", "0", "count", "0", "ms", "1"]);
    fr.setResponse("FT.INFO", ["index_name", "idx:sens", "num_docs", "1000"]);
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
    expect(body.total_sbm).toBe(0);
    // None of the cells skipped — discovery succeeded everywhere.
    expect(body.performance.ops_skipped).toBe(0);
    expect(body.performance.redis_ops_count).toBe(27);
    expect(body.performance.cells_empty).toBe(27);
    for (const entry of body.breakdown) {
      expect(entry.skipped).toBe(false);
      for (const s of ["low", "medium", "high"]) {
        expect(entry.scenarios[s].data_status).toBe("empty");
        expect(entry.scenarios[s].charge).toBe(0);
      }
    }
  });

  it("populated cells with non-zero buckets land as data_status='populated' and cells_empty=0", async () => {
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
    expect(body.performance.cells_empty).toBe(0);
    for (const entry of body.breakdown) {
      for (const s of ["low", "medium", "high"]) {
        expect(entry.scenarios[s].data_status).toBe("populated");
      }
    }
  });
});
