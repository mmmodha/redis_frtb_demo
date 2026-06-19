// Wave 6.39.J — sparse-tenor FT.AGGREGATE fallback graceful handling.
// When the rollup fast-fast path is absent (HGETALL returns empty) and the
// FT.AGGREGATE fallback runs against a dataset where some GIRR per-tenor
// SUM columns surface "NaN" (RediSearch's representation of an all-missing
// SUM input on some Enterprise builds), the per-bucket reducer must collapse
// those values to 0 rather than letting NaN propagate into K_b/S_b and the
// final response body. Wave 6.39.H already wired the LOAD + APPLY @f+0
// arithmetic coercion at the FT.AGGREGATE argv side; this turn closes the
// loop on the post-reply reducer.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { __resetCalcCacheForTests, CALC_DATA_VERSION_KEY } from "../src/sbm/calc-cache.ts";
import { resetActiveTarget } from "../src/active-target.ts";

function sparseTenorSchema() {
  // Minimal schema fixture mirroring `fastPathSchema()` in calc-sbm.test.ts
  // but trimmed to GIRR-only — enough for the fast path to resolve the four
  // per-tenor `ws_girr_delta_<tenor>` field aliases and pick a constant ρ.
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
        tenor: { count: 4, nodes: ["3M", "6M", "1Y", "2Y"] },
        risk_weights_ref: "girr_delta_weights",
        intra_bucket_correlation_ref: "girr_rho_kl",
        cross_bucket_correlation_ref: "girr_gamma_bc",
      },
    },
    risk_weights: {
      girr_delta_weights: { by_tenor: { "3M": 0.017, "6M": 0.017, "1Y": 0.016, "2Y": 0.015 } },
    },
    correlations: {
      girr_rho_kl: { kind: "constant", value: 0 },
      girr_vega_rho_kl: { kind: "constant", value: 0 },
    },
  } as unknown as Parameters<typeof createServer>[0]["schema"];
}

describe("Wave 6.39.J — sparse-tenor FT.AGGREGATE graceful handling", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  const PREV_GATE = process.env.CALC_ALLOW_FT_AGGREGATE;
  const PREV_FAST = process.env.CALC_FAST_PATH;
  const PREV_ROLLUP = process.env.CALC_ROLLUP_PATH;
  const PREV_FCALL = process.env.CALC_FCALL_FALLBACK;

  beforeEach(() => {
    __resetCalcCacheForTests();
    // Force the FT.AGGREGATE fallback path: fast path on, rollup HGETALL
    // empty (set per-test below), FCALL fallback off, gate explicitly on.
    process.env.CALC_FAST_PATH = "1";
    process.env.CALC_ROLLUP_PATH = "1";
    process.env.CALC_FCALL_FALLBACK = "0";
    process.env.CALC_ALLOW_FT_AGGREGATE = "true";
  });

  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
    if (PREV_GATE === undefined) delete process.env.CALC_ALLOW_FT_AGGREGATE;
    else process.env.CALC_ALLOW_FT_AGGREGATE = PREV_GATE;
    if (PREV_FAST === undefined) delete process.env.CALC_FAST_PATH;
    else process.env.CALC_FAST_PATH = PREV_FAST;
    if (PREV_ROLLUP === undefined) delete process.env.CALC_ROLLUP_PATH;
    else process.env.CALC_ROLLUP_PATH = PREV_ROLLUP;
    if (PREV_FCALL === undefined) delete process.env.CALC_FCALL_FALLBACK;
    else process.env.CALC_FCALL_FALLBACK = PREV_FCALL;
  });

  it("GIRR Delta with sparse tenor SUMs (NaN + missing) returns 200 with a finite charge", async () => {
    const fr = fakeRedis();
    fr.setResponse("GET", (args: unknown[]) =>
      args[0] === CALC_DATA_VERSION_KEY ? null : null,
    );
    fr.setResponse("SMEMBERS", () => ["USD"]);
    fr.setResponse("FT.INFO", () => ["num_docs", "100"]);
    // Empty rollup → tryRollupReadout returns null → fallback to FT.AGGREGATE.
    fr.setResponse("HGETALL", () => []);
    // FT.AGGREGATE returns a row where some per-tenor SUMs are "NaN" (sparse
    // tenor: never indexed → RediSearch's representation can land as a
    // non-numeric token) and one tenor is plain-old absent.
    fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
      const hasApply = args.includes("APPLY");
      if (!hasApply) {
        return [1, ["bucket", "USD"]];
      }
      return [
        1,
        [
          "bucket", "USD",
          "sum_d_ws_girr_delta_3M", "5",
          "sum_d_ws_girr_delta_3M_sq", "25",
          "sum_d_ws_girr_delta_6M", "NaN",
          "sum_d_ws_girr_delta_6M_sq", "NaN",
          // 1Y is absent entirely (sparse — never indexed)
          "sum_d_ws_girr_delta_2Y", "nan",
          "sum_d_ws_girr_delta_2Y_sq", "nan",
          "row_count", "10",
        ],
      ];
    });

    app = await createServer({
      redis: fr,
      schema: sparseTenorSchema(),
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" },
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engine).toBe("ft_aggregate");
    // Only the 3M tenor contributed; the rest are sparse/NaN → coerced to 0.
    // ρ=0 → K_b² = Σ_t (sum_ws_t)² = 25 → K_b = 5 → γ=0 → charge = 5.
    expect(typeof body.charge).toBe("number");
    expect(Number.isFinite(body.charge)).toBe(true);
    expect(body.charge).toBeCloseTo(5, 9);
    expect(body.per_bucket).toHaveLength(1);
    const bucket = body.per_bucket[0];
    expect(Number.isFinite(bucket.K_b)).toBe(true);
    expect(Number.isFinite(bucket.S_b)).toBe(true);
    expect(bucket.K_b).toBeCloseTo(5, 9);
  });

  it("GIRR Delta with no-coverage cell (all tenor SUMs sparse) returns 200 with zero charge", async () => {
    const fr = fakeRedis();
    fr.setResponse("GET", (args: unknown[]) =>
      args[0] === CALC_DATA_VERSION_KEY ? null : null,
    );
    fr.setResponse("SMEMBERS", () => ["USD"]);
    fr.setResponse("FT.INFO", () => ["num_docs", "100"]);
    fr.setResponse("HGETALL", () => []);
    // Every per-tenor SUM is sparse — row carries only bucket + count.
    fr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
      const hasApply = args.includes("APPLY");
      if (!hasApply) return [1, ["bucket", "USD"]];
      return [1, ["bucket", "USD", "row_count", "5"]];
    });
    app = await createServer({
      redis: fr,
      schema: sparseTenorSchema(),
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" },
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Number.isFinite(body.charge)).toBe(true);
    expect(body.charge).toBe(0);
    expect(body.per_bucket[0].K_b).toBe(0);
    expect(body.per_bucket[0].S_b).toBe(0);
  });
});
