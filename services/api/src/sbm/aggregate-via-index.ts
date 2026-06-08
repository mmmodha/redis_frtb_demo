// Wave 5.83C-1 — single-FT.AGGREGATE fast path for the per-bucket SBM
// kernels. Replaces the per-bucket FCALL fan-out by aggregating the pre-
// weighted `ws_*` NUMERIC fields (Wave 5.83A/B) server-side, then computing
// K_b/S_b in TS via the constant-ρ closed form (Delta/Vega) or the §21.5(3)
// ψ-gated closed form (Curvature). Selected by the route when
// `CALC_FAST_PATH !== "0"`; Lua FCALL retained behind the flag for
// differential testing.

import type { Schema } from "@frtb/schema";
import type { RedisLike } from "../redis-like.ts";
import type { BucketResult } from "./reduce.ts";
import { kbSquaredForDirection, squareCorrelation } from "@frtb/calc/src/curvatureCommon.ts";

export type FastLeg = "delta" | "vega" | "curvature";

export interface AggregateBucketsOpts {
  redis: RedisLike;
  schema: Schema;
  // Canonical UPPERCASE risk-class key (matches schema.risk_classes keys and
  // the @risk_class TAG values written by the consumer).
  riskClass: string;
  leg: FastLeg;
  filters?: {
    bucketSubset?: ReadonlyArray<string>;
    exclude?: {
      book?: ReadonlyArray<string>;
      trade_id?: ReadonlyArray<string>;
      risk_factor?: ReadonlyArray<string>;
    };
  };
}

// Wave 5.41 — same explicit per-call timeout the legacy discovery FT.AGGREGATE
// carries. Surfaces a slow cluster as a captured error (route translates to
// 502) rather than hanging behind the implicit module default.
const FT_AGGREGATE_TIMEOUT_MS = 30000;

// TAG escape mirroring routes/calc.ts so subset / exclude predicates flow
// through the index query parser intact (numeric bucket ids and FX pairs
// contain `:` / `-` which trip the unescaped form). The set must stay in
// lock-step with the discovery query helper in calc.ts.
const TAG_SPECIALS = /[\s,.<>{}\[\]"':;!@#$%^&*()\-+=~|\/?]/g;
function escapeTag(v: string): string {
  return v.replace(TAG_SPECIALS, (m) => `\\${m}`);
}

// Per-tenor classes — GIRR ships its per-tenor weighted maps under the
// `*_per_tenor` JSONPaths (e.g. `$.weighted_value_per_tenor["3M"]`), so the
// index has one numeric field per tenor (`ws_girr_<leg>_<tenor>`). The bare
// `$.weighted_value` / `$.weighted_cvr_*` paths stay scalar on every class
// (Wave 5.83F — moved to a distinct path to stop the GIRR Object value from
// aborting indexing on the Equity/FX scalar NUMERIC declarations). Equity /
// FX emit scalar `weighted_value` and `weighted_cvr_*` and get a single
// field per leg (`ws_<class>_<leg>`). Keep this in lock-step with
// shared/rqe/src/index.mjs PER_TENOR_CLASSES.
const PER_TENOR_CLASSES = new Set(["GIRR"]);

interface LegFields {
  // `ws_<class>_<leg>[_<tenor>]` field aliases as defined by buildSchemaFields.
  // Delta/Vega → single list. Curvature → up/down lists (per-tenor or singleton).
  delta?: string[];
  vega?: string[];
  cvrUp?: string[];
  cvrDown?: string[];
  // SENSITIVITY_TYPE @sensitivity_type:{...} value the index was populated with.
  sensitivityType: "Delta" | "Vega" | "Curvature";
}

function resolveLegFields(schema: Schema, riskClass: string, leg: FastLeg): LegFields {
  const upper = riskClass.toUpperCase();
  const cls = schema.risk_classes[upper];
  const lower = upper.toLowerCase();
  const isPerTenor = PER_TENOR_CLASSES.has(upper) && cls?.tenor?.nodes?.length;
  const tenors = isPerTenor ? cls!.tenor!.nodes : [""];
  const fieldsFor = (root: string): string[] =>
    tenors.map((t) => (t ? `ws_${lower}_${root}_${t}` : `ws_${lower}_${root}`));
  if (leg === "delta") return { delta: fieldsFor("delta"), sensitivityType: "Delta" };
  if (leg === "vega") return { vega: fieldsFor("vega"), sensitivityType: "Vega" };
  return {
    cvrUp: fieldsFor("cvr_up"),
    cvrDown: fieldsFor("cvr_down"),
    sensitivityType: "Curvature",
  };
}

// Resolve the intra-bucket correlation ρ the closed-form K_b uses for this
// (class, leg). Mirrors the bootstrap.ts snippet wiring so the Lua kernel and
// the fast path consume the same correlations constant.
function resolveRho(schema: Schema, riskClass: string, leg: FastLeg): number {
  const upper = riskClass.toUpperCase();
  const c = schema.correlations;
  const get = (key: string): number => {
    const spec = c[key];
    return spec && spec.kind === "constant" ? spec.value : 0;
  };
  if (upper === "GIRR" && leg === "vega") return get("girr_vega_rho_kl");
  // Curvature ρ_curv = (ρ_delta)² per §21.5(3).
  const cls = schema.risk_classes[upper];
  const ref = cls?.intra_bucket_correlation_ref;
  const rhoDelta = ref ? get(ref) : 0;
  if (leg === "curvature") return squareCorrelation(rhoDelta);
  return rhoDelta;
}

// Reusable engine-tag literal so the route + helper agree on the wire shape
// without a stringly-typed seam.
export const FAST_PATH_ENGINE = "ft_aggregate" as const;
export const LUA_PATH_ENGINE = "fcall_lua" as const;

// Returns master-shard nodes for fan-out, or [client] in standalone mode —
// same feature-check shape as routes/calc.ts and bootstrap.ts so cluster +
// standalone behaviour stays consistent across the three call sites.
function resolveQueryNodes(client: RedisLike): RedisLike[] {
  const maybe = client as { nodes?: (role: string) => RedisLike[] };
  if (typeof maybe.nodes === "function") return maybe.nodes("master");
  return [client];
}

// Build the @risk_class + @sensitivity_type + optional @bucket / exclude
// predicates. Exclude TAGs are negated with `-` so rows matching ANY value in
// the list are dropped before aggregation — same semantics as the kernel-side
// _frtb_excluded helper, just pushed up into the index query.
export function buildFastPathQuery(
  riskClass: string,
  sensitivityType: "Delta" | "Vega" | "Curvature",
  filters?: AggregateBucketsOpts["filters"],
): string {
  const parts: string[] = [
    `@risk_class:{${escapeTag(riskClass)}}`,
    `@sensitivity_type:{${escapeTag(sensitivityType)}}`,
  ];
  const subset = filters?.bucketSubset;
  if (subset && subset.length > 0) {
    parts.push(`@bucket:{${subset.map(escapeTag).join("|")}}`);
  }
  const ex = filters?.exclude;
  if (ex) {
    for (const key of ["book", "trade_id", "risk_factor"] as const) {
      const list = ex[key];
      if (list && list.length > 0) {
        parts.push(`-@${key}:{${list.map(escapeTag).join("|")}}`);
      }
    }
  }
  return parts.join(" ");
}

export { FT_AGGREGATE_TIMEOUT_MS, resolveLegFields, resolveRho, resolveQueryNodes };

// Build the FT.AGGREGATE argv after the command name. APPLY clauses derive
// per-row squared sums (and sign-split helpers for Curvature) before GROUPBY
// so the closed-form K_b only needs the resulting per-bucket SUMs. Field aliases
// for the reducer outputs are stable so parseAggregateReply can re-index them
// by name regardless of column order in the reply.
//
// Reducer alias scheme:
//   Delta/Vega:    sum_<root>[_<tenor>], sum_<root>[_<tenor>]_sq
//   Curvature:     same + sum_<root>_neg + sum_<root>_neg_sq per direction
// `count` is always the COUNT 0 reducer (one per bucket).
//
// Wave 5.83J1 — per-tenor classes (GIRR) leave most `ws_<class>_<leg>_<tenor>`
// fields unset on any given doc (each row populates only the tenors it carries),
// so referencing them directly in APPLY trips RediSearch's "Could not find the
// value for a parameter name, consider using EXISTS" error. Pre-coalesce each
// indexed field to 0 via `case(exists(@f),@f,0)` then drive every downstream
// APPLY + REDUCE off the safe alias.
// Wave 5.83J3 — extended the coalesce to the scalar classes (EQUITY / FX /
// Curvature). The live 5.84A/B throughput smokes can write rows where the
// per-class `ws_*` field never lands (ingest-side pollution), and the bare
// `@ws_equity_delta` / `@ws_fx_delta` reference tripped the same EXISTS
// error J1 fixed for GIRR. The `perTenor` parameter is retained for the
// public signature but no longer gates the safe-alias rewrite.
export function buildFastPathAggregateArgs(
  query: string,
  fields: LegFields,
  perTenor: boolean = false,
): unknown[] {
  void perTenor;
  const args: unknown[] = ["idx:sens", query];
  const applyClauses: Array<[string, string]> = [];
  const sumReducers: Array<[string, string]> = [];
  const safeRef = (f: string): string => {
    const alias = `${f}_safe`;
    applyClauses.push([`case(exists(@${f}),@${f},0)`, alias]);
    return alias;
  };
  const addNumericLeg = (roots: string[], prefix: string): void => {
    for (const f of roots) {
      const safe = safeRef(f);
      const sqAlias = `${prefix}_${f}_sq`;
      applyClauses.push([`(@${safe}*@${safe})`, sqAlias]);
      sumReducers.push([safe, `sum_${prefix}_${f}`]);
      sumReducers.push([sqAlias, `sum_${prefix}_${f}_sq`]);
    }
  };
  const addCurvatureLeg = (roots: string[], prefix: string): void => {
    for (const f of roots) {
      const safe = safeRef(f);
      const negAlias = `${prefix}_${f}_neg`;
      const sqAlias = `${prefix}_${f}_sq`;
      const negSqAlias = `${prefix}_${f}_negsq`;
      applyClauses.push([`(@${safe}<0)*@${safe}`, negAlias]);
      applyClauses.push([`(@${safe}*@${safe})`, sqAlias]);
      applyClauses.push([`(((@${safe}<0)*@${safe})*((@${safe}<0)*@${safe}))`, negSqAlias]);
      sumReducers.push([safe, `sum_${prefix}_${f}`]);
      sumReducers.push([sqAlias, `sum_${prefix}_${f}_sq`]);
      sumReducers.push([negAlias, `sum_${prefix}_${f}_neg`]);
      sumReducers.push([negSqAlias, `sum_${prefix}_${f}_negsq`]);
    }
  };
  if (fields.delta) addNumericLeg(fields.delta, "d");
  if (fields.vega) addNumericLeg(fields.vega, "v");
  if (fields.cvrUp) addCurvatureLeg(fields.cvrUp, "u");
  if (fields.cvrDown) addCurvatureLeg(fields.cvrDown, "n");
  for (const [expr, alias] of applyClauses) {
    args.push("APPLY", expr, "AS", alias);
  }
  args.push("GROUPBY", "1", "@bucket");
  for (const [src, alias] of sumReducers) {
    args.push("REDUCE", "SUM", "1", `@${src}`, "AS", alias);
  }
  args.push("REDUCE", "COUNT", "0", "AS", "row_count");
  args.push("LIMIT", "0", "10000");
  args.push("DIALECT", "2");
  args.push("TIMEOUT", String(FT_AGGREGATE_TIMEOUT_MS));
  return args;
}

// Parse one FT.AGGREGATE reply into a Map of bucket → key/value record. Tolerant
// of both flat key/value rows (RESP2) and map-shaped rows (RESP3 / in-process
// fakes). Numeric coercion happens at the K_b/S_b reduce step, not here.
export function parseAggregateRows(reply: unknown): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!Array.isArray(reply)) return out;
  for (let i = 1; i < reply.length; i++) {
    const row = reply[i];
    const m: Record<string, string> = {};
    if (Array.isArray(row)) {
      for (let j = 0; j < row.length; j += 2) {
        const k = String(row[j]).replace(/^@/, "");
        m[k] = String(row[j + 1]);
      }
    } else if (row && typeof row === "object") {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        m[k.replace(/^@/, "")] = String(v);
      }
    }
    const bucket = m.bucket;
    if (!bucket) continue;
    // In cluster fan-out duplicate bucket rows can appear if two masters both
    // own slot-affine partitions for the same hash-tag (not the case under the
    // Wave 2 contract, but the merge keeps the math stable on hostile data).
    const prev = out.get(bucket);
    if (!prev) {
      out.set(bucket, m);
    } else {
      const merged: Record<string, string> = { ...prev };
      for (const [k, v] of Object.entries(m)) {
        if (k === "bucket") continue;
        const cur = Number(merged[k] ?? 0);
        merged[k] = String(cur + Number(v));
      }
      out.set(bucket, merged);
    }
  }
  return out;
}

// Constant-ρ K_b closed form: K_b² = ΣWS² + ρ·((ΣWS)² − ΣWS²). Mirrors the Lua
// kernels (girr_delta.lua, equity_delta.lua, fx_delta.lua, *_vega.lua) so the
// fast path stays byte-identical when the input aggregates match.
function kbFromConstantRho(sumWs: number, sumWsSq: number, rho: number): number {
  let cross = sumWs * sumWs - sumWsSq;
  if (cross < 0) cross = 0;
  let kbSq = sumWsSq + rho * cross;
  if (kbSq < 0) kbSq = 0;
  return Math.sqrt(kbSq);
}

// Pull the four sign-split aggregates per indexed field for the Curvature leg
// and reduce to a per-bucket K_b using the §21.5(3) ψ-gated closed form. The
// `pre` prefix matches buildFastPathAggregateArgs reducer aliases.
function kbCurvatureForDirection(
  row: Record<string, string>,
  fields: ReadonlyArray<string>,
  prefix: "u" | "n",
  rhoCurv: number,
  perTenor: boolean,
): { K_b: number; S_b: number } {
  if (perTenor) {
    // Per-tenor classes (GIRR): K_b² operates on the per-tenor SUMs across rows
    // (mirroring girr_curvature.lua), so use the ψ-aware kernel from the shared
    // curvature oracle directly. The sign-split aggregates are unused.
    const cvr = fields.map((f) => Number(row[`sum_${prefix}_${f}`] ?? 0));
    const kbSq = Math.max(0, kbSquaredForDirection(cvr, rhoCurv));
    const S_b = cvr.reduce((a, b) => a + b, 0);
    return { K_b: Math.sqrt(kbSq), S_b };
  }
  // Scalar classes (Equity / FX): each row is its own factor k. ψ gates on
  // (row_k, row_l); the sign-split decomposition lets us recover the gated
  // cross term from per-bucket aggregates without per-row data:
  //   Σ_{k≠l} a_k a_l                     = S² − SQ
  //   Σ_{k<0,l<0,k≠l} a_k a_l             = N² − SQN
  //   ψ-gated cross = total − both-negative
  const f = fields[0]!;
  const S = Number(row[`sum_${prefix}_${f}`] ?? 0);
  const SQ = Number(row[`sum_${prefix}_${f}_sq`] ?? 0);
  const N = Number(row[`sum_${prefix}_${f}_neg`] ?? 0);
  const SQN = Number(row[`sum_${prefix}_${f}_negsq`] ?? 0);
  const totalCross = S * S - SQ;
  const negCross = N * N - SQN;
  const gatedCross = totalCross - negCross;
  const kbSq = Math.max(0, SQ + rhoCurv * gatedCross);
  return { K_b: Math.sqrt(kbSq), S_b: S };
}

// Per-bucket reducer: pulls the right aggregates from a single GROUPBY row and
// returns a BucketResult shaped exactly like the FCALL reply parser does.
function bucketResultFromRow(
  row: Record<string, string>,
  fields: LegFields,
  leg: FastLeg,
  rho: number,
  perTenor: boolean,
  startNs: bigint,
): BucketResult {
  const bucket = row.bucket ?? "";
  const count = Number(row.row_count ?? 0);
  const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
  if (leg === "delta" || leg === "vega") {
    const list = (leg === "delta" ? fields.delta : fields.vega) ?? [];
    if (perTenor && leg === "delta") {
      // GIRR Delta: sum_ws_sq operates on the per-tenor SUMs (not the per-row
      // squared sums) — see girr_delta.lua. Square the per-tenor totals in TS.
      const wsK = list.map((f) => Number(row[`sum_d_${f}`] ?? 0));
      const sumWs = wsK.reduce((a, b) => a + b, 0);
      const sumWsSq = wsK.reduce((acc, x) => acc + x * x, 0);
      return { bucket, K_b: kbFromConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count, ms };
    }
    // Per-row sum_ws_sq matches the *_vega.lua and equity/fx_delta.lua shape.
    const prefix = leg === "delta" ? "d" : "v";
    let sumWs = 0;
    let sumWsSq = 0;
    for (const f of list) {
      sumWs += Number(row[`sum_${prefix}_${f}`] ?? 0);
      sumWsSq += Number(row[`sum_${prefix}_${f}_sq`] ?? 0);
    }
    return { bucket, K_b: kbFromConstantRho(sumWs, sumWsSq, rho), S_b: sumWs, count, ms };
  }
  // Curvature — pick the worse of K_b^+ / K_b^- per §21.5(3); S_b is the signed
  // Σ_k CVR_k of the winning direction (consumed by reduceCurvatureCharge).
  const up = kbCurvatureForDirection(row, fields.cvrUp ?? [], "u", rho, perTenor);
  const down = kbCurvatureForDirection(row, fields.cvrDown ?? [], "n", rho, perTenor);
  if (down.K_b > up.K_b) return { bucket, K_b: down.K_b, S_b: down.S_b, count, ms };
  return { bucket, K_b: up.K_b, S_b: up.S_b, count, ms };
}

export async function aggregateBucketsViaIndex(opts: AggregateBucketsOpts): Promise<BucketResult[]> {
  const start = process.hrtime.bigint();
  const riskClass = opts.riskClass.toUpperCase();
  const fields = resolveLegFields(opts.schema, riskClass, opts.leg);
  const rho = resolveRho(opts.schema, riskClass, opts.leg);
  const perTenor = PER_TENOR_CLASSES.has(riskClass) && (opts.schema.risk_classes[riskClass]?.tenor?.nodes?.length ?? 0) > 0;
  const query = buildFastPathQuery(riskClass, fields.sensitivityType, opts.filters);
  const argv = buildFastPathAggregateArgs(query, fields, perTenor);
  const nodes = resolveQueryNodes(opts.redis);
  const merged = new Map<string, Record<string, string>>();
  for (const node of nodes) {
    const reply = await node.call("FT.AGGREGATE", ...argv);
    const rows = parseAggregateRows(reply);
    for (const [b, r] of rows) {
      const prev = merged.get(b);
      if (!prev) { merged.set(b, r); continue; }
      const next: Record<string, string> = { ...prev };
      for (const [k, v] of Object.entries(r)) {
        if (k === "bucket") continue;
        const cur = Number(next[k] ?? 0);
        next[k] = String(cur + Number(v));
      }
      merged.set(b, next);
    }
  }
  const out: BucketResult[] = [];
  for (const row of merged.values()) {
    out.push(bucketResultFromRow(row, fields, opts.leg, rho, perTenor, start));
  }
  return out;
}

