// Wave 5.83D-1 — differential parity harness between the legacy Lua FCALL
// path (CALC_FAST_PATH=0) and the FT.AGGREGATE fast path (CALC_FAST_PATH=1).
//
// For each of the nine {GIRR,EQUITY,FX} × {Delta,Vega,Curvature} variants we
// build a small (5-20 rows) single-bucket fixture, drive both paths through
// the same /calc/sbm endpoint, and assert that per-bucket K_b/S_b agree
// within ≤1e-9 and count is exact. The fast-path FT.AGGREGATE stub is built
// from `enrichDoc`-derived weighted fields (so the fast aggregate matches
// what the live index would emit) and the FCALL stub returns what the Lua
// kernels would compute on the same raw rows. Both sides share the same
// closed form, so the differential gate is mathematical parity between the
// two reduction sites — not a re-run of the formula.
//
// Companion canonical end-to-end gate is in the `Canonical 6k dataset`
// block at the bottom and gates on RUN_CANONICAL_E2E=1 because the
// 9558.91465449378 number only reproduces against the standalone Redis Cloud
// DB seeded with the smoke-run-17 6k fixture (Wave 5.17d).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";
import { __resetCalcCacheForTests } from "../src/sbm/calc-cache.ts";
import { enrichDoc } from "../../ingest/src/consumer.ts";
import { kbSquaredForDirection } from "@frtb/calc/src/curvatureCommon.ts";

// Shared in-memory schema mirroring the fast-path test fixture in
// calc-sbm.test.ts. Picks bucket/weight values so the closed-form K_b is
// hand-verifiable but the parity assertions don't depend on the numbers.
function diffSchema() {
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
      girr_rho_kl: { kind: "constant", value: 0.4 },
      girr_vega_rho_kl: { kind: "constant", value: 0.3 },
      equity_rho: { kind: "constant", value: 0.5 },
      fx_rho: { kind: "constant", value: 0 },
    },
  } as unknown as Parameters<typeof createServer>[0]["schema"];
}

// FT.AGGREGATE discovery reply: [total, ["bucket", b], ...]
function ftDiscoverReply(buckets: string[]): unknown[] {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}
// FT.AGGREGATE aliased row for the fast path (RESP2 flat key/value).
function ftAggRow(bucket: string, kv: Record<string, number>): unknown[] {
  const row: unknown[] = ["bucket", bucket];
  for (const [k, v] of Object.entries(kv)) row.push(k, String(v));
  return row;
}

// Constant-ρ K_b closed form — mirrors girr_delta.lua / equity_delta.lua /
// *_vega.lua and aggregate-via-index.ts so this oracle is a single source
// of truth for both stub sides.
function kbConstantRho(sumWs: number, sumWsSq: number, rho: number): number {
  const cross = Math.max(0, sumWs * sumWs - sumWsSq);
  return Math.sqrt(Math.max(0, sumWsSq + rho * cross));
}

// Run /calc/sbm under both flag states with the same fixture and assert
// per-bucket K_b/S_b parity within ≤1e-9. Each path gets its own fakeRedis
// instance so the FCALL/FT.AGGREGATE stubs don't clash.
async function runDifferential(opts: {
  schema: Parameters<typeof createServer>[0]["schema"];
  riskClass: string;
  sensitivityType: "Delta" | "Vega" | "Curvature";
  bucket: string;
  // Lua-path reply for `redis.call('FCALL', funcName, 1, key, risk_class, b, ...)`
  luaFcallReply: { K_b: number; S_b: number; count: number };
  // Fast-path FT.AGGREGATE aliased fields (sum_*_ws_*, *_sq, row_count, ...)
  fastAggregateRow: Record<string, number>;
}) {
  const savedFlag = process.env.CALC_FAST_PATH;
  try {
    // --- Lua path (CALC_FAST_PATH=0) ---
    process.env.CALC_FAST_PATH = "0";
    __resetCalcCacheForTests();
    const luaFr = fakeRedis();
    luaFr.setResponse("FT.AGGREGATE", ftDiscoverReply([opts.bucket]));
    luaFr.setResponse("FCALL", () =>
      JSON.stringify({ ...opts.luaFcallReply, ms: 0 }),
    );
    const luaApp = await createServer({ redis: luaFr, schema: opts.schema });
    const luaRes = await luaApp.inject({
      method: "POST", url: "/calc/sbm",
      payload: { risk_class: opts.riskClass, sensitivity_type: opts.sensitivityType },
    });
    expect(luaRes.statusCode).toBe(200);
    const lua = luaRes.json();
    expect(lua.engine).toBe("fcall_lua");
    await luaApp.close();

    // --- Fast path (CALC_FAST_PATH=1) ---
    process.env.CALC_FAST_PATH = "1";
    __resetCalcCacheForTests();
    const fastFr: FakeRedis = fakeRedis();
    fastFr.setResponse("FT.AGGREGATE", (args: unknown[]) =>
      args.includes("APPLY")
        ? [1, ftAggRow(opts.bucket, opts.fastAggregateRow)]
        : ftDiscoverReply([opts.bucket]),
    );
    const fastApp = await createServer({ redis: fastFr, schema: opts.schema });
    const fastRes = await fastApp.inject({
      method: "POST", url: "/calc/sbm",
      payload: { risk_class: opts.riskClass, sensitivity_type: opts.sensitivityType },
    });
    expect(fastRes.statusCode).toBe(200);
    const fast = fastRes.json();
    expect(fast.engine).toBe("ft_aggregate");
    await fastApp.close();

    // Per-bucket parity gate — the contract for Wave 5.83D-1.
    expect(lua.per_bucket).toHaveLength(1);
    expect(fast.per_bucket).toHaveLength(1);
    const L = lua.per_bucket[0];
    const F = fast.per_bucket[0];
    expect(L.bucket).toBe(F.bucket);
    expect(Math.abs(L.K_b - F.K_b)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(L.S_b - F.S_b)).toBeLessThanOrEqual(1e-9);
    expect(L.count).toBe(F.count);
    // Risk-class roll-up parity (single-bucket → charge == K_b for γ=0
    // cases; for non-zero γ both sides feed the same reducer so they agree).
    expect(Math.abs(lua.charge - fast.charge)).toBeLessThanOrEqual(1e-9);
    return { lua, fast };
  } finally {
    if (savedFlag === undefined) delete process.env.CALC_FAST_PATH;
    else process.env.CALC_FAST_PATH = savedFlag;
  }
}


describe("Wave 5.83D-1 — Lua ⇄ FT.AGGREGATE differential parity (9 variants)", () => {
  beforeEach(() => __resetCalcCacheForTests());
  afterEach(() => __resetCalcCacheForTests());

  // ---- Equity Delta (scalar): WS_k = w_bucket · s_k per row ----
  it("Equity Delta — scalar per-row weighting matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "1";
    const w = schema.risk_weights.equity_weights.by_bucket[bucket];
    const rho = schema.correlations.equity_rho.value;
    const spots = [0.10, -0.20, 0.30, -0.05, 0.15];
    let sumWs = 0, sumWsSq = 0;
    for (const s of spots) { const ws = w * s; sumWs += ws; sumWsSq += ws * ws; }
    await runDifferential({
      schema, riskClass: "Equity", sensitivityType: "Delta", bucket,
      luaFcallReply: { K_b: kbConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count: spots.length },
      fastAggregateRow: {
        sum_d_ws_equity_delta: sumWs,
        sum_d_ws_equity_delta_sq: sumWsSq,
        row_count: spots.length,
      },
    });
  });

  // ---- Equity Vega (scalar, w=1.0): pre-weighted weighted_value from enrichDoc ----
  it("Equity Vega — scalar w=1.0 matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "1";
    const rho = schema.correlations.equity_rho.value;
    const rows = [0.40, -0.10, 0.25, 0.05, -0.30].map((spot) => ({
      risk_class: "EQUITY", bucket, sensitivity_type: "Vega", risk_value: { spot },
    }));
    let sumWs = 0, sumWsSq = 0;
    for (const r of rows) {
      const wv = enrichDoc(r, schema).weighted_value as number;
      sumWs += wv; sumWsSq += wv * wv;
    }
    await runDifferential({
      schema, riskClass: "Equity", sensitivityType: "Vega", bucket,
      luaFcallReply: { K_b: kbConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count: rows.length },
      fastAggregateRow: {
        sum_v_ws_equity_vega: sumWs,
        sum_v_ws_equity_vega_sq: sumWsSq,
        row_count: rows.length,
      },
    });
  });

  // ---- Equity Curvature (scalar): sign-split aggregates per direction ----
  it("Equity Curvature — scalar ψ-gated K_b matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "1";
    const rhoCurv = schema.correlations.equity_rho.value ** 2;
    const rows = [
      { cvr_up: 0.30, cvr_down: 0.10 },
      { cvr_up: -0.20, cvr_down: 0.40 },
      { cvr_up: 0.50, cvr_down: -0.15 },
      { cvr_up: -0.10, cvr_down: -0.25 },
      { cvr_up: 0.20, cvr_down: 0.05 },
    ].map((rv) => ({ risk_class: "EQUITY", bucket, sensitivity_type: "Curvature", risk_value: rv }));

    // Lua reference: row-level ψ-gated cross on raw CVRs (weight=1 in
    // equity_curvature.lua), then pick the worse direction.
    const upRaw = rows.map((r) => (r.risk_value as any).cvr_up as number);
    const downRaw = rows.map((r) => (r.risk_value as any).cvr_down as number);
    const kbUp = Math.sqrt(Math.max(0, kbSquaredForDirection(upRaw, rhoCurv)));
    const kbDown = Math.sqrt(Math.max(0, kbSquaredForDirection(downRaw, rhoCurv)));
    const sUp = upRaw.reduce((a, b) => a + b, 0);
    const sDown = downRaw.reduce((a, b) => a + b, 0);
    const lua = kbDown > kbUp
      ? { K_b: kbDown, S_b: sDown, count: rows.length }
      : { K_b: kbUp, S_b: sUp, count: rows.length };

    // Fast aggregates: enrichDoc passes raw CVRs through (Curvature weight=1.0).
    const acc = { uS: 0, uSQ: 0, uN: 0, uSQN: 0, dS: 0, dSQ: 0, dN: 0, dSQN: 0 };
    for (const r of rows) {
      const e = enrichDoc(r, schema);
      const u = e.weighted_cvr_up as number; const d = e.weighted_cvr_down as number;
      acc.uS += u; acc.uSQ += u * u; acc.uN += u < 0 ? u : 0; acc.uSQN += u < 0 ? u * u : 0;
      acc.dS += d; acc.dSQ += d * d; acc.dN += d < 0 ? d : 0; acc.dSQN += d < 0 ? d * d : 0;
    }
    await runDifferential({
      schema, riskClass: "Equity", sensitivityType: "Curvature", bucket,
      luaFcallReply: lua,
      fastAggregateRow: {
        sum_u_ws_equity_cvr_up: acc.uS, sum_u_ws_equity_cvr_up_sq: acc.uSQ,
        sum_u_ws_equity_cvr_up_neg: acc.uN, sum_u_ws_equity_cvr_up_negsq: acc.uSQN,
        sum_n_ws_equity_cvr_down: acc.dS, sum_n_ws_equity_cvr_down_sq: acc.dSQ,
        sum_n_ws_equity_cvr_down_neg: acc.dN, sum_n_ws_equity_cvr_down_negsq: acc.dSQN,
        row_count: rows.length,
      },
    });
  });

  // ---- FX Delta (scalar): WS_k = w · s_k per row, ρ_fx = 0 ----
  it("FX Delta — scalar per-row weighting matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "EURUSD";
    const w = schema.risk_weights.fx_weights.constant;
    const rho = schema.correlations.fx_rho.value;
    const spots = [0.50, -0.30, 0.20, 0.45, -0.10];
    let sumWs = 0, sumWsSq = 0;
    for (const s of spots) { const ws = w * s; sumWs += ws; sumWsSq += ws * ws; }
    await runDifferential({
      schema, riskClass: "FX", sensitivityType: "Delta", bucket,
      luaFcallReply: { K_b: kbConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count: spots.length },
      fastAggregateRow: {
        sum_d_ws_fx_delta: sumWs,
        sum_d_ws_fx_delta_sq: sumWsSq,
        row_count: spots.length,
      },
    });
  });

  // ---- FX Vega (scalar, w=1.0) ----
  it("FX Vega — scalar w=1.0 matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "EURUSD";
    const rho = schema.correlations.fx_rho.value;
    const rows = [0.25, -0.40, 0.10, 0.60, -0.05].map((spot) => ({
      risk_class: "FX", bucket, sensitivity_type: "Vega", risk_value: { spot },
    }));
    let sumWs = 0, sumWsSq = 0;
    for (const r of rows) {
      const wv = enrichDoc(r, schema).weighted_value as number;
      sumWs += wv; sumWsSq += wv * wv;
    }
    await runDifferential({
      schema, riskClass: "FX", sensitivityType: "Vega", bucket,
      luaFcallReply: { K_b: kbConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count: rows.length },
      fastAggregateRow: {
        sum_v_ws_fx_vega: sumWs,
        sum_v_ws_fx_vega_sq: sumWsSq,
        row_count: rows.length,
      },
    });
  });

  // ---- FX Curvature (scalar) ----
  it("FX Curvature — scalar ψ-gated K_b matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "EURUSD";
    const rhoCurv = schema.correlations.fx_rho.value ** 2;  // 0 — but the formula still exercises both branches
    const rows = [
      { cvr_up: 0.35, cvr_down: -0.20 },
      { cvr_up: -0.15, cvr_down: 0.40 },
      { cvr_up: 0.25, cvr_down: 0.10 },
      { cvr_up: -0.30, cvr_down: -0.45 },
      { cvr_up: 0.50, cvr_down: 0.05 },
      { cvr_up: -0.05, cvr_down: 0.15 },
    ].map((rv) => ({ risk_class: "FX", bucket, sensitivity_type: "Curvature", risk_value: rv }));
    const upRaw = rows.map((r) => (r.risk_value as any).cvr_up as number);
    const downRaw = rows.map((r) => (r.risk_value as any).cvr_down as number);
    const kbUp = Math.sqrt(Math.max(0, kbSquaredForDirection(upRaw, rhoCurv)));
    const kbDown = Math.sqrt(Math.max(0, kbSquaredForDirection(downRaw, rhoCurv)));
    const sUp = upRaw.reduce((a, b) => a + b, 0);
    const sDown = downRaw.reduce((a, b) => a + b, 0);
    const lua = kbDown > kbUp
      ? { K_b: kbDown, S_b: sDown, count: rows.length }
      : { K_b: kbUp, S_b: sUp, count: rows.length };
    const acc = { uS: 0, uSQ: 0, uN: 0, uSQN: 0, dS: 0, dSQ: 0, dN: 0, dSQN: 0 };
    for (const r of rows) {
      const e = enrichDoc(r, schema);
      const u = e.weighted_cvr_up as number; const d = e.weighted_cvr_down as number;
      acc.uS += u; acc.uSQ += u * u; acc.uN += u < 0 ? u : 0; acc.uSQN += u < 0 ? u * u : 0;
      acc.dS += d; acc.dSQ += d * d; acc.dN += d < 0 ? d : 0; acc.dSQN += d < 0 ? d * d : 0;
    }
    await runDifferential({
      schema, riskClass: "FX", sensitivityType: "Curvature", bucket,
      luaFcallReply: lua,
      fastAggregateRow: {
        sum_u_ws_fx_cvr_up: acc.uS, sum_u_ws_fx_cvr_up_sq: acc.uSQ,
        sum_u_ws_fx_cvr_up_neg: acc.uN, sum_u_ws_fx_cvr_up_negsq: acc.uSQN,
        sum_n_ws_fx_cvr_down: acc.dS, sum_n_ws_fx_cvr_down_sq: acc.dSQ,
        sum_n_ws_fx_cvr_down_neg: acc.dN, sum_n_ws_fx_cvr_down_negsq: acc.dSQN,
        row_count: rows.length,
      },
    });
  });

  // ---- GIRR Delta (per-tenor): WS_k = w_k · Σ_rows s_k ----
  it("GIRR Delta — per-tenor sums matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "USD";
    const tenors: string[] = schema.risk_classes.GIRR.tenor.nodes;
    const weights = schema.risk_weights.girr_delta_weights.by_tenor as Record<string, number>;
    const rho = schema.correlations.girr_rho_kl.value;
    const rows = [
      { "3M": 0.50, "6M": 0.30, "1Y": -0.10 },
      { "3M": -0.20, "6M": 0.40, "1Y": 0.25 },
      { "3M": 0.15, "6M": -0.05, "1Y": 0.35 },
      { "3M": 0.05, "6M": 0.20, "1Y": -0.15 },
      { "3M": -0.10, "6M": 0.10, "1Y": 0.05 },
    ].map((rv) => ({ risk_class: "GIRR", bucket, sensitivity_type: "Delta", risk_value: rv as any }));
    // Lua: per-tenor SUM across rows, then WS_k = w_k · sum_s[k].
    const perTenorSum: Record<string, number> = Object.fromEntries(tenors.map((t) => [t, 0]));
    for (const r of rows) {
      const rv = r.risk_value as Record<string, number>;
      for (const t of tenors) perTenorSum[t]! += rv[t]!;
    }
    const wsPerTenor = tenors.map((t) => weights[t]! * perTenorSum[t]!);
    const sumWs = wsPerTenor.reduce((a, b) => a + b, 0);
    const sumWsSq = wsPerTenor.reduce((a, x) => a + x * x, 0);
    // Fast aggregates: per-tenor SUM of enrichDoc's weighted_value_per_tenor[t].
    // Wave 5.83F — per-tenor map moved off `$.weighted_value` (now scalar Σ).
    const fastFields: Record<string, number> = { row_count: rows.length };
    for (const t of tenors) {
      let s = 0;
      for (const r of rows) {
        const wv = (enrichDoc(r, schema).weighted_value_per_tenor as Record<string, number>)[t]!;
        s += wv;
      }
      fastFields[`sum_d_ws_girr_delta_${t}`] = s;
      // sum_sq alias unused on perTenor delta branch but the reducer emits it.
      fastFields[`sum_d_ws_girr_delta_${t}_sq`] = 0;
    }
    await runDifferential({
      schema, riskClass: "GIRR", sensitivityType: "Delta", bucket,
      luaFcallReply: { K_b: kbConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count: rows.length },
      fastAggregateRow: fastFields,
    });
  });

  // ---- GIRR Vega (per-tenor, w=1.0): per-row per-tenor squared sums ----
  it("GIRR Vega — per-row per-tenor accumulation matches across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "USD";
    const tenors: string[] = schema.risk_classes.GIRR.tenor.nodes;
    const rho = schema.correlations.girr_vega_rho_kl.value;
    const rows = [
      { "3M": 0.20, "6M": 0.10, "1Y": -0.05 },
      { "3M": -0.15, "6M": 0.25, "1Y": 0.30 },
      { "3M": 0.10, "6M": -0.20, "1Y": 0.05 },
      { "3M": 0.40, "6M": 0.15, "1Y": -0.10 },
      { "3M": -0.05, "6M": 0.05, "1Y": 0.20 },
    ].map((rv) => ({ risk_class: "GIRR", bucket, sensitivity_type: "Vega", risk_value: rv as any }));
    // Lua girr_vega: per-row per-tenor accumulation with w=1.0.
    let sumWs = 0, sumWsSq = 0;
    for (const r of rows) {
      const rv = r.risk_value as Record<string, number>;
      for (const t of tenors) { const ws = rv[t]!; sumWs += ws; sumWsSq += ws * ws; }
    }
    // Fast aggregates: per-tenor SUM and SUM(sq) over weighted_value_per_tenor cells.
    // Wave 5.83F — per-tenor map moved off `$.weighted_value` (now scalar Σ).
    const fastFields: Record<string, number> = { row_count: rows.length };
    for (const t of tenors) {
      let s = 0, sq = 0;
      for (const r of rows) {
        const wv = (enrichDoc(r, schema).weighted_value_per_tenor as Record<string, number>)[t]!;
        s += wv; sq += wv * wv;
      }
      fastFields[`sum_v_ws_girr_vega_${t}`] = s;
      fastFields[`sum_v_ws_girr_vega_${t}_sq`] = sq;
    }
    await runDifferential({
      schema, riskClass: "GIRR", sensitivityType: "Vega", bucket,
      luaFcallReply: { K_b: kbConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count: rows.length },
      fastAggregateRow: fastFields,
    });
  });

  // ---- GIRR Curvature (per-tenor, w=1.0): ψ-gated K_b on per-tenor sums ----
  it("GIRR Curvature — per-tenor sums with ψ-gated K_b match across both paths", async () => {
    const schema = diffSchema() as any;
    const bucket = "USD";
    const tenors: string[] = schema.risk_classes.GIRR.tenor.nodes;
    const rhoCurv = schema.correlations.girr_rho_kl.value ** 2;
    const rows = [
      { cvr_up: [0.30, 0.20, -0.10], cvr_down: [0.10, -0.05, 0.15] },
      { cvr_up: [-0.20, 0.40, 0.25], cvr_down: [0.20, 0.30, -0.10] },
      { cvr_up: [0.15, -0.25, 0.10], cvr_down: [-0.15, 0.10, 0.05] },
      { cvr_up: [0.05, 0.15, 0.30], cvr_down: [0.25, -0.20, 0.15] },
    ].map((rv) => ({ risk_class: "GIRR", bucket, sensitivity_type: "Curvature", risk_value: rv as any }));
    // Lua: per-tenor SUM across rows for each direction; K_b² via ψ-gated cross.
    const sumUp = tenors.map((_, k) => rows.reduce((a, r) => a + (r.risk_value as any).cvr_up[k], 0));
    const sumDown = tenors.map((_, k) => rows.reduce((a, r) => a + (r.risk_value as any).cvr_down[k], 0));
    const kbUp = Math.sqrt(Math.max(0, kbSquaredForDirection(sumUp, rhoCurv)));
    const kbDown = Math.sqrt(Math.max(0, kbSquaredForDirection(sumDown, rhoCurv)));
    const sUp = sumUp.reduce((a, b) => a + b, 0);
    const sDown = sumDown.reduce((a, b) => a + b, 0);
    const lua = kbDown > kbUp
      ? { K_b: kbDown, S_b: sDown, count: rows.length }
      : { K_b: kbUp, S_b: sUp, count: rows.length };
    // Fast: per-tenor SUM of weighted_cvr_{up,down}_per_tenor via enrichDoc.
    // Wave 5.83F — per-tenor maps moved off `$.weighted_cvr_*` (now scalar Σ).
    // The per-tenor branch ignores sign-split aggregates, but emit zeroed
    // aliases so the reducer reads stable strings (parseAggregateRows tolerates
    // them).
    const fastFields: Record<string, number> = { row_count: rows.length };
    for (let k = 0; k < tenors.length; k++) {
      const t = tenors[k]!;
      let sU = 0, sD = 0;
      for (const r of rows) {
        const e = enrichDoc(r, schema);
        const up = (e.weighted_cvr_up_per_tenor as Record<string, number>)[t]!;
        const dn = (e.weighted_cvr_down_per_tenor as Record<string, number>)[t]!;
        sU += up; sD += dn;
      }
      fastFields[`sum_u_ws_girr_cvr_up_${t}`] = sU;
      fastFields[`sum_u_ws_girr_cvr_up_${t}_sq`] = 0;
      fastFields[`sum_u_ws_girr_cvr_up_${t}_neg`] = 0;
      fastFields[`sum_u_ws_girr_cvr_up_${t}_negsq`] = 0;
      fastFields[`sum_n_ws_girr_cvr_down_${t}`] = sD;
      fastFields[`sum_n_ws_girr_cvr_down_${t}_sq`] = 0;
      fastFields[`sum_n_ws_girr_cvr_down_${t}_neg`] = 0;
      fastFields[`sum_n_ws_girr_cvr_down_${t}_negsq`] = 0;
    }
    await runDifferential({
      schema, riskClass: "GIRR", sensitivityType: "Curvature", bucket,
      luaFcallReply: lua,
      fastAggregateRow: fastFields,
    });
  });
});


// Wave 5.83D-1 — canonical end-to-end gate. Reproduces the smoke-run-17
// `grand_total_l2 = 9558.91465449378` by hitting a real Redis target (see
// docs/recordings/smoke-run-17/SUMMARY.md). Gated on RUN_CANONICAL_E2E=1
// because the assertion is contingent on the live target being seeded with
// the canonical 6k fixture (2 000 each Delta/Vega/Curvature) AND the api
// bootstrap having loaded the current `services/calc/lib/*.lua` library.
// Required env: REDIS_URL (and REDIS_CLUSTER, REDIS_TLS as the active target
// expects). Skipped silently otherwise so CI stays hermetic.
describe.skipIf(process.env.RUN_CANONICAL_E2E !== "1")(
  "Wave 5.83D-1 — canonical 6k dataset grand_total_l2 parity",
  () => {
    it("CALC_FAST_PATH ∈ {0,1} both yield grand_total_l2 = 9558.91465449378", async () => {
      const { createRedisClient } = await import("@frtb/redis-client");
      const { loadSchema } = await import("@frtb/schema");
      const redis = createRedisClient({ lazyConnect: false });
      try {
        const schemaPath = process.env.SCHEMA_FILE ?? "config/schema/frtb-default.yaml";
        const schema = loadSchema(schemaPath);
        const variants: Array<{ rc: string; st: "Delta" | "Vega" | "Curvature" }> = [
          { rc: "GIRR", st: "Delta" }, { rc: "GIRR", st: "Vega" }, { rc: "GIRR", st: "Curvature" },
          { rc: "EQUITY", st: "Delta" }, { rc: "EQUITY", st: "Vega" }, { rc: "EQUITY", st: "Curvature" },
          { rc: "FX", st: "Delta" }, { rc: "FX", st: "Vega" }, { rc: "FX", st: "Curvature" },
        ];
        async function l2(flag: "0" | "1"): Promise<number> {
          process.env.CALC_FAST_PATH = flag;
          __resetCalcCacheForTests();
          const app = await createServer({ redis: redis as any, schema, logger: false });
          try {
            let sumSq = 0;
            for (const v of variants) {
              const res = await app.inject({
                method: "POST", url: "/calc/sbm",
                payload: { risk_class: v.rc, sensitivity_type: v.st },
              });
              expect(res.statusCode, `${v.rc}/${v.st} (flag=${flag})`).toBe(200);
              const charge = Number(res.json().charge);
              sumSq += charge * charge;
            }
            return Math.sqrt(sumSq);
          } finally { await app.close(); }
        }
        const luaL2 = await l2("0");
        const fastL2 = await l2("1");
        const canonical = 9558.91465449378;
        expect(Math.abs(luaL2 - canonical)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(fastL2 - canonical)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(luaL2 - fastL2)).toBeLessThanOrEqual(1e-9);
      } finally {
        if (typeof (redis as any).quit === "function") await (redis as any).quit().catch(() => undefined);
      }
    }, 60_000);
  },
);
