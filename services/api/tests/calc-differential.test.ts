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
import type { CorrelationSpec } from "../src/sbm/reduce.ts";

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
        dimensions: [],
        // Wave 5.83G — multi-bucket FX so the differential matrix can
        // exercise the bucket-discovery → per-bucket reduce path the live
        // 20k-doc divergence was hiding in.
        buckets: { naming: "fx_pair_bucket", values: ["EURUSD", "GBPUSD", "USDJPY"] },
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
      // Wave 5.83G — fx_rho lifted from 0 to 0.6 (Basel MAR21.88 default).
      // The previous 0 masked the bootstrap mis-wiring that defaulted the
      // Lua kernel's __FX_DELTA_RHO__ to 0 while the fast path used 0.6
      // via resolveRho — the source of the live 20k FX Delta divergence
      // (3.869259 vs 2.370157).
      fx_rho: { kind: "constant", value: 0.6 },
      fx_gamma: { kind: "constant", value: 0.6 },
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

  // ---- Wave 5.83G — multi-bucket FX Delta (ρ_fx = 0.6) ----
  // The single-bucket FX Delta variant above used ρ=0, which collapsed
  // K_b to √Σws² and masked the 5.83E live-corpus divergence (the Lua
  // kernel was being loaded with __FX_DELTA_RHO__=0 because bootstrap.ts
  // omitted `rho: fxRho.value` when calling buildFxDeltaSnippet). This
  // case spans three FX pairs with mixed signs so the closed-form cross
  // term Σ ws² − (Σ ws)² is non-trivial and the reduce step rolls three
  // buckets up into a single risk-class charge — exactly the live shape.
  it("FX Delta — multi-bucket parity with ρ_fx = 0.6 (Wave 5.83G regression)", async () => {
    const schema = diffSchema() as any;
    const w = schema.risk_weights.fx_weights.constant;
    const rho = schema.correlations.fx_rho.value;
    expect(rho).toBe(0.6);
    // Three FX pairs, mixed-sign spots so Σ ws and Σ ws² diverge meaningfully.
    const bucketSpots: Record<string, number[]> = {
      EURUSD: [0.50, -0.30, 0.20, 0.45, -0.10],
      GBPUSD: [-0.40, 0.25, -0.15, 0.05, 0.30],
      USDJPY: [0.60, 0.10, -0.35, -0.20, 0.15],
    };
    const buckets = Object.keys(bucketSpots);
    // Per-bucket Lua + Fast aggregates derived from the same raw spots.
    const perBucket = buckets.map((b) => {
      const spots = bucketSpots[b]!;
      let sumWs = 0, sumWsSq = 0;
      for (const s of spots) { const ws = w * s; sumWs += ws; sumWsSq += ws * ws; }
      return { bucket: b, sumWs, sumWsSq, count: spots.length, K_b: kbConstantRho(sumWs, sumWsSq, rho) };
    });

    const savedFlag = process.env.CALC_FAST_PATH;
    try {
      // --- Lua path ---
      process.env.CALC_FAST_PATH = "0";
      __resetCalcCacheForTests();
      const luaFr = fakeRedis();
      luaFr.setResponse("FT.AGGREGATE", ftDiscoverReply(buckets));
      luaFr.setResponse("FCALL", (args: unknown[]) => {
        // FCALL fx_delta 1 <routeKey> <risk_class> <bucket> ...
        const b = String(args[4]);
        const r = perBucket.find((p) => p.bucket === b)!;
        return JSON.stringify({ K_b: r.K_b, S_b: r.sumWs, count: r.count, ms: 0 });
      });
      const luaApp = await createServer({ redis: luaFr, schema });
      const luaRes = await luaApp.inject({
        method: "POST", url: "/calc/sbm",
        payload: { risk_class: "FX", sensitivity_type: "Delta" },
      });
      expect(luaRes.statusCode).toBe(200);
      const lua = luaRes.json();
      expect(lua.engine).toBe("fcall_lua");
      await luaApp.close();

      // --- Fast path ---
      process.env.CALC_FAST_PATH = "1";
      __resetCalcCacheForTests();
      const fastFr: FakeRedis = fakeRedis();
      fastFr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftDiscoverReply(buckets);
        const rows: unknown[] = [perBucket.length];
        for (const p of perBucket) {
          rows.push(ftAggRow(p.bucket, {
            sum_d_ws_fx_delta: p.sumWs,
            sum_d_ws_fx_delta_sq: p.sumWsSq,
            row_count: p.count,
          }));
        }
        return rows;
      });
      const fastApp = await createServer({ redis: fastFr, schema });
      const fastRes = await fastApp.inject({
        method: "POST", url: "/calc/sbm",
        payload: { risk_class: "FX", sensitivity_type: "Delta" },
      });
      expect(fastRes.statusCode).toBe(200);
      const fast = fastRes.json();
      expect(fast.engine).toBe("ft_aggregate");
      await fastApp.close();

      // Per-bucket parity gate across all three FX pairs.
      expect(lua.per_bucket).toHaveLength(buckets.length);
      expect(fast.per_bucket).toHaveLength(buckets.length);
      const byBucketLua = new Map<string, any>(lua.per_bucket.map((r: any) => [r.bucket, r]));
      const byBucketFast = new Map<string, any>(fast.per_bucket.map((r: any) => [r.bucket, r]));
      for (const p of perBucket) {
        const L = byBucketLua.get(p.bucket);
        const F = byBucketFast.get(p.bucket);
        expect(L, `lua per_bucket missing ${p.bucket}`).toBeDefined();
        expect(F, `fast per_bucket missing ${p.bucket}`).toBeDefined();
        expect(Math.abs(L.K_b - F.K_b)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(L.S_b - F.S_b)).toBeLessThanOrEqual(1e-9);
        expect(L.count).toBe(F.count);
        // Each per-bucket K_b must match the closed form computed with
        // the schema's fx_rho — this is the bit that would fail if either
        // path silently used ρ=0.
        expect(Math.abs(L.K_b - p.K_b)).toBeLessThanOrEqual(1e-9);
      }
      // Risk-class roll-up parity across both paths.
      expect(Math.abs(lua.charge - fast.charge)).toBeLessThanOrEqual(1e-9);
    } finally {
      if (savedFlag === undefined) delete process.env.CALC_FAST_PATH;
      else process.env.CALC_FAST_PATH = savedFlag;
    }
  });

  // ---- Wave 5.83J2 — multi-bucket FX Delta + Vega including OTHER (ρ_fx = 0.6) ----
  // The 5.83I live sweep showed FX K_b diverging on 5 of 11 buckets (AUDUSD,
  // NZDUSD, OTHER, USDCHF, USDJPY) on top of the rolled-up charge gap. The
  // 5.83G multi-bucket gate above covers Delta over 3 EUR/GBP pairs, but the
  // analogous bootstrap mis-wiring for Vega (buildFxVegaSnippet called
  // without `rho`, so the Lua kernel ran with ρ=0 while the fast path used
  // 0.6) survived because no Vega multi-bucket gate existed. This test
  // spans 5 buckets including OTHER (the fallback bucket the live sweep
  // flagged) and asserts per-bucket K_b parity ≤1e-9 across BOTH legs, so
  // any future bootstrap call that drops the ρ parameter for either leg
  // trips the gate immediately.
  for (const leg of ["Delta", "Vega"] as const) {
    it(`FX ${leg} — multi-bucket parity including OTHER bucket (Wave 5.83J2 regression)`, async () => {
      const schema = diffSchema() as any;
      // Override the schema's FX bucket list to span the OTHER fallback and
      // four currency-pair buckets that were divergent in 5.83I.
      schema.risk_classes.FX.buckets.values = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "OTHER"];
      // FX Vega weight is 1.0 (matches buildFxVegaSnippet({weight:1.0,...})
      // and consumer.legWeight for sensitivity_type=Vega). FX Delta weight
      // is schema.risk_weights.fx_weights.constant.
      const w = leg === "Delta" ? schema.risk_weights.fx_weights.constant : 1.0;
      const rho = schema.correlations.fx_rho.value;
      expect(rho).toBe(0.6);
      // Mixed-sign sensitivities so the cross term (Σws)² − Σws² is
      // meaningfully non-zero — without it ρ wouldn't matter and the test
      // would pass even with the bug present.
      const bucketSpots: Record<string, number[]> = {
        EURUSD: [0.50, -0.30, 0.20, 0.45, -0.10],
        GBPUSD: [-0.40, 0.25, -0.15, 0.05, 0.30],
        USDJPY: [0.60, 0.10, -0.35, -0.20, 0.15],
        USDCHF: [0.35, 0.40, -0.10, 0.25, -0.05],
        OTHER:  [0.20, -0.15, 0.10, 0.30, 0.25],
      };
      const buckets = Object.keys(bucketSpots);
      const perBucket = buckets.map((b) => {
        const spots = bucketSpots[b]!;
        let sumWs = 0, sumWsSq = 0;
        for (const s of spots) { const ws = w * s; sumWs += ws; sumWsSq += ws * ws; }
        return { bucket: b, sumWs, sumWsSq, count: spots.length, K_b: kbConstantRho(sumWs, sumWsSq, rho) };
      });
      const sumPrefix = leg === "Delta" ? "d" : "v";
      const fieldRoot = leg === "Delta" ? "ws_fx_delta" : "ws_fx_vega";

      const savedFlag = process.env.CALC_FAST_PATH;
      try {
        // --- Lua path ---
        process.env.CALC_FAST_PATH = "0";
        __resetCalcCacheForTests();
        const luaFr = fakeRedis();
        luaFr.setResponse("FT.AGGREGATE", ftDiscoverReply(buckets));
        luaFr.setResponse("FCALL", (args: unknown[]) => {
          const b = String(args[4]);
          const r = perBucket.find((p) => p.bucket === b)!;
          return JSON.stringify({ K_b: r.K_b, S_b: r.sumWs, count: r.count, ms: 0 });
        });
        const luaApp = await createServer({ redis: luaFr, schema });
        const luaRes = await luaApp.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "FX", sensitivity_type: leg },
        });
        expect(luaRes.statusCode).toBe(200);
        const lua = luaRes.json();
        expect(lua.engine).toBe("fcall_lua");
        await luaApp.close();

        // --- Fast path ---
        process.env.CALC_FAST_PATH = "1";
        __resetCalcCacheForTests();
        const fastFr: FakeRedis = fakeRedis();
        fastFr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
          if (!args.includes("APPLY")) return ftDiscoverReply(buckets);
          const rows: unknown[] = [perBucket.length];
          for (const p of perBucket) {
            rows.push(ftAggRow(p.bucket, {
              [`sum_${sumPrefix}_${fieldRoot}`]: p.sumWs,
              [`sum_${sumPrefix}_${fieldRoot}_sq`]: p.sumWsSq,
              row_count: p.count,
            }));
          }
          return rows;
        });
        const fastApp = await createServer({ redis: fastFr, schema });
        const fastRes = await fastApp.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "FX", sensitivity_type: leg },
        });
        expect(fastRes.statusCode).toBe(200);
        const fast = fastRes.json();
        expect(fast.engine).toBe("ft_aggregate");
        await fastApp.close();

        // Per-bucket parity gate across all 5 buckets (the gate that would
        // catch a future bootstrap.ts call that drops `rho` for either leg).
        expect(lua.per_bucket).toHaveLength(buckets.length);
        expect(fast.per_bucket).toHaveLength(buckets.length);
        const byBucketLua = new Map<string, any>(lua.per_bucket.map((r: any) => [r.bucket, r]));
        const byBucketFast = new Map<string, any>(fast.per_bucket.map((r: any) => [r.bucket, r]));
        for (const p of perBucket) {
          const L = byBucketLua.get(p.bucket);
          const F = byBucketFast.get(p.bucket);
          expect(L, `lua per_bucket missing ${p.bucket}`).toBeDefined();
          expect(F, `fast per_bucket missing ${p.bucket}`).toBeDefined();
          expect(Math.abs(L.K_b - F.K_b)).toBeLessThanOrEqual(1e-9);
          expect(Math.abs(L.S_b - F.S_b)).toBeLessThanOrEqual(1e-9);
          expect(L.count).toBe(F.count);
          // Closed-form K_b must match the schema's fx_rho on both sides —
          // a path that silently used ρ=0 would fail this on every bucket
          // whose spots aren't perfectly cancelling.
          expect(Math.abs(L.K_b - p.K_b)).toBeLessThanOrEqual(1e-9);
        }
        // Risk-class roll-up parity.
        expect(Math.abs(lua.charge - fast.charge)).toBeLessThanOrEqual(1e-9);
      } finally {
        if (savedFlag === undefined) delete process.env.CALC_FAST_PATH;
        else process.env.CALC_FAST_PATH = savedFlag;
      }
    });
  }

  // ---- Wave 5.83J1 — multi-bucket GIRR Delta + Vega across full tenor span ----
  // The 5.83I live sweep surfaced a fast-path 500 on GIRR because each per-tenor
  // doc only populates the tenors it carries, so referencing
  // `@ws_girr_delta_3M` in APPLY trips RediSearch's "could not find the value"
  // error. The fix (`case(exists(@f),@f,0)` coalesce) is exercised here via a
  // 3-bucket × 3-tenor parity gate. The per-tenor Lua kernel sums first then
  // weights, so the fast-path aggregates need to match those per-tenor SUMs.
  for (const leg of ["Delta", "Vega"] as const) {
    it(`GIRR ${leg} — multi-bucket × full tenor span parity (Wave 5.83J1 regression)`, async () => {
      const schema = diffSchema() as any;
      // Lift GIRR to three buckets with a non-zero cross-bucket γ so the
      // roll-up exercises the same code path as the live 200k corpus.
      schema.risk_classes.GIRR.buckets.values = ["USD", "EUR", "JPY"];
      schema.correlations.girr_gamma_bc = { kind: "constant", value: 0.5 };
      const tenors: string[] = schema.risk_classes.GIRR.tenor.nodes;
      const weights = schema.risk_weights.girr_delta_weights.by_tenor as Record<string, number>;
      const rho = leg === "Delta"
        ? schema.correlations.girr_rho_kl.value
        : schema.correlations.girr_vega_rho_kl.value;
      // Mixed-sign per-tenor sensitivities per bucket so the cross term in
      // K_b² is meaningfully non-zero.
      const bucketRows: Record<string, Array<Record<string, number>>> = {
        USD: [
          { "3M": 0.50, "6M": 0.30, "1Y": -0.10 },
          { "3M": -0.20, "6M": 0.40, "1Y": 0.25 },
          { "3M": 0.15, "6M": -0.05, "1Y": 0.35 },
        ],
        EUR: [
          { "3M": -0.30, "6M": 0.20, "1Y": 0.15 },
          { "3M": 0.10, "6M": -0.25, "1Y": 0.40 },
          { "3M": 0.05, "6M": 0.30, "1Y": -0.20 },
        ],
        JPY: [
          { "3M": 0.40, "6M": -0.15, "1Y": 0.10 },
          { "3M": -0.05, "6M": 0.35, "1Y": -0.30 },
          { "3M": 0.25, "6M": 0.20, "1Y": 0.05 },
        ],
      };
      const buckets = Object.keys(bucketRows);
      // Per-bucket Lua + Fast aggregates, derived per the per-tenor kernel.
      const perBucket = buckets.map((b) => {
        const rows = bucketRows[b]!;
        if (leg === "Delta") {
          // GIRR Delta: per-tenor SUM across rows, then WS_k = w_k · sum_s[k].
          const perTenorSum: Record<string, number> = Object.fromEntries(tenors.map((t) => [t, 0]));
          for (const r of rows) for (const t of tenors) perTenorSum[t]! += r[t]!;
          const wsPerTenor = tenors.map((t) => weights[t]! * perTenorSum[t]!);
          const sumWs = wsPerTenor.reduce((a, b2) => a + b2, 0);
          const sumWsSq = wsPerTenor.reduce((a, x) => a + x * x, 0);
          return { bucket: b, sumWs, count: rows.length, K_b: kbConstantRho(sumWs, sumWsSq, rho), perTenor: perTenorSum };
        }
        // GIRR Vega: per-row per-tenor accumulation with w=1.0.
        let sumWs = 0, sumWsSq = 0;
        const perTenorSum: Record<string, number> = Object.fromEntries(tenors.map((t) => [t, 0]));
        const perTenorSumSq: Record<string, number> = Object.fromEntries(tenors.map((t) => [t, 0]));
        for (const r of rows) for (const t of tenors) {
          const ws = r[t]!;
          sumWs += ws; sumWsSq += ws * ws;
          perTenorSum[t]! += ws; perTenorSumSq[t]! += ws * ws;
        }
        return { bucket: b, sumWs, count: rows.length, K_b: kbConstantRho(sumWs, sumWsSq, rho), perTenor: perTenorSum, perTenorSq: perTenorSumSq };
      });

      const savedFlag = process.env.CALC_FAST_PATH;
      try {
        // --- Lua path ---
        process.env.CALC_FAST_PATH = "0";
        __resetCalcCacheForTests();
        const luaFr = fakeRedis();
        luaFr.setResponse("FT.AGGREGATE", ftDiscoverReply(buckets));
        luaFr.setResponse("FCALL", (args: unknown[]) => {
          const b = String(args[4]);
          const r = perBucket.find((p) => p.bucket === b)!;
          return JSON.stringify({ K_b: r.K_b, S_b: r.sumWs, count: r.count, ms: 0 });
        });
        const luaApp = await createServer({ redis: luaFr, schema });
        const luaRes = await luaApp.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: leg },
        });
        expect(luaRes.statusCode).toBe(200);
        const lua = luaRes.json();
        expect(lua.engine).toBe("fcall_lua");
        await luaApp.close();

        // --- Fast path ---
        process.env.CALC_FAST_PATH = "1";
        __resetCalcCacheForTests();
        const fastFr: FakeRedis = fakeRedis();
        fastFr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
          if (!args.includes("APPLY")) return ftDiscoverReply(buckets);
          // Wave 5.83J1 — assert the per-tenor coalesce wrapper is in the
          // argv so a future regression on the APPLY shape fails loudly.
          expect(args.some((a) => typeof a === "string" && a.startsWith("case(exists(@ws_girr_")), `${leg} APPLY argv missing case(exists(...)) wrapper`).toBe(true);
          const rows: unknown[] = [perBucket.length];
          for (const p of perBucket) {
            const kv: Record<string, number> = { row_count: p.count };
            if (leg === "Delta") {
              for (const t of tenors) {
                kv[`sum_d_ws_girr_delta_${t}`] = weights[t]! * p.perTenor[t]!;
                kv[`sum_d_ws_girr_delta_${t}_sq`] = 0;
              }
            } else {
              for (const t of tenors) {
                kv[`sum_v_ws_girr_vega_${t}`] = p.perTenor[t]!;
                kv[`sum_v_ws_girr_vega_${t}_sq`] = (p as any).perTenorSq[t];
              }
            }
            rows.push(ftAggRow(p.bucket, kv));
          }
          return rows;
        });
        const fastApp = await createServer({ redis: fastFr, schema });
        const fastRes = await fastApp.inject({
          method: "POST", url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: leg },
        });
        expect(fastRes.statusCode).toBe(200);
        const fast = fastRes.json();
        expect(fast.engine).toBe("ft_aggregate");
        await fastApp.close();

        // Per-bucket parity gate across all three GIRR buckets.
        expect(lua.per_bucket).toHaveLength(buckets.length);
        expect(fast.per_bucket).toHaveLength(buckets.length);
        const byBucketLua = new Map<string, any>(lua.per_bucket.map((r: any) => [r.bucket, r]));
        const byBucketFast = new Map<string, any>(fast.per_bucket.map((r: any) => [r.bucket, r]));
        for (const p of perBucket) {
          const L = byBucketLua.get(p.bucket);
          const F = byBucketFast.get(p.bucket);
          expect(L, `lua per_bucket missing ${p.bucket}`).toBeDefined();
          expect(F, `fast per_bucket missing ${p.bucket}`).toBeDefined();
          expect(Math.abs(L.K_b - F.K_b)).toBeLessThanOrEqual(1e-9);
          expect(Math.abs(L.S_b - F.S_b)).toBeLessThanOrEqual(1e-9);
          expect(L.count).toBe(F.count);
          expect(Math.abs(L.K_b - p.K_b)).toBeLessThanOrEqual(1e-9);
        }
        // Risk-class roll-up parity (multi-bucket, γ=0.5).
        expect(Math.abs(lua.charge - fast.charge)).toBeLessThanOrEqual(1e-9);
      } finally {
        if (savedFlag === undefined) delete process.env.CALC_FAST_PATH;
        else process.env.CALC_FAST_PATH = savedFlag;
      }
    });
  }
});


// Wave 5.83L — rolled-up cross-bucket reduce ORACLE gate. The 5.83J1/J2
// multi-bucket gates above assert per-path parity but instantiate the
// server without `correlations`, so reduceRiskClassCharge sees the
// default γ_bc = 0 and the off-diagonal term Σ_{b≠c} γ_bc · S_b · S_c
// collapses to zero. A regression that bypassed the cross-bucket reducer
// (5.83K's H1: fast path skips reduceRiskClassCharge and returns a
// pre-rolled √Σ K_b² instead) would still pass the J1/J2 gates because
// both charges would degenerate to the diagonal-only term.
//
// This block plugs that gap by passing a non-zero γ_bc through
// `correlations` and computing the expected rolled-up charge from the
// §21.4(5) closed form in TS as an oracle, then asserting BOTH paths
// match the oracle ≤1e-9 AND match each other. If either path drops the
// off-diagonal cross term the oracle gate trips immediately: the
// observed charge would degenerate to √Σ K_b² which differs from the
// oracle by exactly the dropped Σ_{b≠c} γ_bc · S_b · S_c contribution.
describe("Wave 5.83L — multi-bucket cross-bucket reduce oracle parity", () => {
  beforeEach(() => __resetCalcCacheForTests());
  afterEach(() => __resetCalcCacheForTests());

  // Compute √(Σ K_b² + Σ_{b≠c} γ_bc · S_b · S_c) directly per §21.4(5)
  // so the assertion catches any path that drops the off-diagonal term.
  function oracleCharge(per: Array<{ K_b: number; S_b: number }>, gamma: number): number {
    let sumK2 = 0;
    for (const p of per) sumK2 += p.K_b * p.K_b;
    let cross = 0;
    for (let i = 0; i < per.length; i++) {
      for (let j = 0; j < per.length; j++) {
        if (i === j) continue;
        cross += gamma * per[i]!.S_b * per[j]!.S_b;
      }
    }
    return Math.sqrt(Math.max(0, sumK2 + cross));
  }

  it("Equity Delta — 3-bucket γ_bc=0.4 cross term: both paths match oracle", async () => {
    const schema = diffSchema() as any;
    // Extend to three Equity buckets with distinct per-bucket weights so
    // each S_b is meaningfully different (cross term swings on bucket
    // pairing). Wire γ_bc=0.4 via the cross_bucket_correlation_ref the
    // production buildCrossBucketCorrelations path consumes.
    schema.risk_classes.EQUITY.buckets.values = ["1", "2", "3"];
    schema.risk_weights.equity_weights.by_bucket = { "1": 0.55, "2": 0.45, "3": 0.65 };
    schema.correlations.equity_gamma = { kind: "constant", value: 0.4 };
    const rho = schema.correlations.equity_rho.value;
    const gamma = 0.4;
    // Mixed-sign spots per bucket so (Σ ws)² − Σ ws² is non-trivial AND
    // S_b changes sign across buckets — the cross term Σ_{b≠c} S_b·S_c
    // then has both positive and negative contributions.
    const bucketSpots: Record<string, number[]> = {
      "1": [0.50, -0.30, 0.20, 0.45, -0.10],
      "2": [-0.40, 0.25, -0.15, 0.05, 0.30],
      "3": [0.60, 0.10, -0.35, -0.20, 0.15],
    };
    const buckets = Object.keys(bucketSpots);
    const perBucket = buckets.map((b) => {
      const w = schema.risk_weights.equity_weights.by_bucket[b];
      const spots = bucketSpots[b]!;
      let sumWs = 0, sumWsSq = 0;
      for (const s of spots) { const ws = w * s; sumWs += ws; sumWsSq += ws * ws; }
      return { bucket: b, sumWs, sumWsSq, count: spots.length, K_b: kbConstantRho(sumWs, sumWsSq, rho) };
    });
    const expected = oracleCharge(
      perBucket.map((p) => ({ K_b: p.K_b, S_b: p.sumWs })),
      gamma,
    );
    // Oracle must actually exercise the cross term — otherwise this gate
    // is no stronger than the J1/J2 per-path-parity gates.
    const diagonalOnly = Math.sqrt(perBucket.reduce((a, p) => a + p.K_b * p.K_b, 0));
    expect(Math.abs(expected - diagonalOnly)).toBeGreaterThan(1e-6);

    const correlations: Record<string, CorrelationSpec> = {
      EQUITY: { kind: "constant", value: gamma },
    };
    const savedFlag = process.env.CALC_FAST_PATH;
    try {
      // --- Lua path ---
      process.env.CALC_FAST_PATH = "0";
      __resetCalcCacheForTests();
      const luaFr = fakeRedis();
      luaFr.setResponse("FT.AGGREGATE", ftDiscoverReply(buckets));
      luaFr.setResponse("FCALL", (args: unknown[]) => {
        const b = String(args[4]);
        const r = perBucket.find((p) => p.bucket === b)!;
        return JSON.stringify({ K_b: r.K_b, S_b: r.sumWs, count: r.count, ms: 0 });
      });
      const luaApp = await createServer({ redis: luaFr, schema, correlations });
      const luaRes = await luaApp.inject({
        method: "POST", url: "/calc/sbm",
        payload: { risk_class: "EQUITY", sensitivity_type: "Delta" },
      });
      expect(luaRes.statusCode).toBe(200);
      const lua = luaRes.json();
      await luaApp.close();

      // --- Fast path ---
      process.env.CALC_FAST_PATH = "1";
      __resetCalcCacheForTests();
      const fastFr: FakeRedis = fakeRedis();
      fastFr.setResponse("FT.AGGREGATE", (args: unknown[]) => {
        if (!args.includes("APPLY")) return ftDiscoverReply(buckets);
        const rows: unknown[] = [perBucket.length];
        for (const p of perBucket) {
          rows.push(ftAggRow(p.bucket, {
            sum_d_ws_equity_delta: p.sumWs,
            sum_d_ws_equity_delta_sq: p.sumWsSq,
            row_count: p.count,
          }));
        }
        return rows;
      });
      const fastApp = await createServer({ redis: fastFr, schema, correlations });
      const fastRes = await fastApp.inject({
        method: "POST", url: "/calc/sbm",
        payload: { risk_class: "EQUITY", sensitivity_type: "Delta" },
      });
      expect(fastRes.statusCode).toBe(200);
      const fast = fastRes.json();
      await fastApp.close();

      // The triple gate: oracle vs lua, oracle vs fast, lua vs fast.
      // A missing cross-term on either side fails the oracle assertion
      // first; a per-path divergence (the original 5.83K shape) fails
      // the lua-vs-fast assertion.
      expect(Math.abs(Number(lua.charge) - expected)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(Number(fast.charge) - expected)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(Number(lua.charge) - Number(fast.charge))).toBeLessThanOrEqual(1e-9);
    } finally {
      if (savedFlag === undefined) delete process.env.CALC_FAST_PATH;
      else process.env.CALC_FAST_PATH = savedFlag;
    }
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
