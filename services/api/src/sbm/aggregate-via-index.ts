// Wave 5.83C-1 — single-FT.AGGREGATE fast path for the per-bucket SBM
// kernels. Replaces the per-bucket FCALL fan-out by aggregating the pre-
// weighted `ws_*` NUMERIC fields (Wave 5.83A/B) server-side, then computing
// K_b/S_b in TS via the constant-ρ closed form (Delta/Vega) or the §21.5(3)
// ψ-gated closed form (Curvature). Selected by the route when
// `CALC_FAST_PATH !== "0"`; Lua FCALL retained behind the flag for
// differential testing.

import type { Schema } from "@frtb/schema";
import type { RedisLike } from "../redis-like.ts";
import type {
  BucketIntermediate,
  BucketResult,
  CrossComponent,
  CvrComponent,
  WsComponent,
} from "./reduce.ts";
import { kbSquaredForDirection, squareCorrelation } from "@frtb/calc/src/curvatureCommon.ts";
// Wave 6.14b — share the canonical rollup key shape + hash field names with
// the ingest writer (Wave 6.14a) so a schema change lands atomically in both
// services rather than drifting under one of them.
import { rollupKey } from "@frtb/calc-shared/rollup-keys";
// Wave 6.39.B — bucket-level K_b cache. Lookup before the per-bucket math,
// store on miss so subsequent warm calls skip the (per-tenor for GIRR
// Curvature, scalar for Equity / FX) closed-form re-derivation. perTenor /
// curvature variants are tracked as a follow-up; this turn ships scalar
// Delta/Vega wiring (the dominant volume) so /metrics counters reflect
// real cache activity.
import {
  computeRollupContentHash,
  kbCacheKey,
  lookupKbCacheEntry,
  storeKbCacheEntry,
} from "./kb-cache.ts";
// Wave 6.41.E.fix5 — version-aware FT.AGGREGATE APPLY null-coercion. See the
// comment block above buildFastPathAggregateArgs for the rationale.
import { getSearchModuleMajorVersion } from "../lib/search-module-version.ts";

export type FastLeg = "delta" | "vega" | "curvature";

// Wave 5.96A.1 — opt-in per-component breakdown. The main /calc/sbm route
// requests `{ crossTopN: 10 }` so the response carries top-10 cross-term pairs
// per bucket; the /calc/sbm/bucket-cross-detail endpoint requests
// `{ crossTopN: null }` for a single bucket to surface the full pair list.
export interface ComponentsOpts {
  crossTopN: number | null;
}

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
      // Wave 6.41.A — desk / bucket exclude pushed into the FT.AGGREGATE
      // query as `-@field:{X|Y}`. region is resolved to desks by the route
      // before this struct is built, so the kernel only ever sees desks.
      desk?: ReadonlyArray<string>;
      bucket?: ReadonlyArray<string>;
    };
    // Wave 6.41.A — positive-include push-down. Pushed into the index
    // query as `@field:{X|Y}`. risk_factor is intentionally absent — the
    // kernel keeps the existing exclude.risk_factor shape only.
    include?: {
      book?: ReadonlyArray<string>;
      trade_id?: ReadonlyArray<string>;
      desk?: ReadonlyArray<string>;
      bucket?: ReadonlyArray<string>;
    };
  };
  // Wave 5.96A.1 — when present, populate ws_components / cross_components /
  // cvr_components on each per-bucket intermediate. For perTenor classes
  // (GIRR) components are derived from the main aggregate; non-perTenor
  // classes (Equity / FX) require a second FT.AGGREGATE grouped by risk_factor.
  components?: ComponentsOpts;
  // Wave 6.18i — versioned `idx:sens:v{hash7}` resolved by the route via
  // getSensIndexName. Wave 6.30.B2 — required so a caller can no longer
  // silently fall back to the literal `idx:sens` on a cluster where only
  // the versioned name exists (the 412 "idx:sens not found" reproducer).
  // Wave 7.0.2.B — when `lazyMath` is true, the caller is responsible for
  // resolving the slim variant (`idx:sens:slim:v{hash7}` via
  // `getSlimSensIndexName`) and passing it here. The helper does not flip
  // the index name based on `lazyMath` — explicit so the route's
  // resolved_command echo and the live FT.AGGREGATE stay in lock-step.
  indexName: string;
  // Wave 7.0.2.B — lazy-math fast path. When true: read raw `s_*` fields
  // from the slim index, fold weight literals into the APPLY clauses, and
  // post-multiply per-bucket sums by the bucket weight in the TS reducer
  // for `by_bucket` Delta shapes. Vega/Curvature ALWAYS use weight 1.0
  // (see `resolveLazyMathWeights`). Default false preserves the
  // pre-7.0.2.B fat-index path byte-for-byte.
  lazyMath?: boolean;
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
  return resolveLegFieldsForPrefix(schema, riskClass, leg, "ws");
}

// Wave 7.0.2.B — slim-index variant. Returns the same `LegFields` shape but
// with `s_*` aliases (raw per-class per-tenor sensitivities from the
// idx:sens:slim schema) instead of `ws_*` (pre-weighted from the fat
// idx:sens schema). Consumed by `aggregateBucketsViaIndex` when the
// lazyMath flag is set; the APPLY clause folds the weight literal in
// before reducer aggregation. Per-tenor / scalar split mirrors the fat
// resolver and the slim schema's `buildSlimSchemaFields` iteration.
function resolveSlimLegFields(schema: Schema, riskClass: string, leg: FastLeg): LegFields {
  return resolveLegFieldsForPrefix(schema, riskClass, leg, "s");
}

function resolveLegFieldsForPrefix(
  schema: Schema,
  riskClass: string,
  leg: FastLeg,
  prefix: "ws" | "s",
): LegFields {
  const upper = riskClass.toUpperCase();
  const cls = schema.risk_classes[upper];
  const lower = upper.toLowerCase();
  const isPerTenor = PER_TENOR_CLASSES.has(upper) && cls?.tenor?.nodes?.length;
  const tenors = isPerTenor ? cls!.tenor!.nodes : [""];
  const fieldsFor = (root: string): string[] =>
    tenors.map((t) => (t ? `${prefix}_${lower}_${root}_${t}` : `${prefix}_${lower}_${root}`));
  if (leg === "delta") return { delta: fieldsFor("delta"), sensitivityType: "Delta" };
  if (leg === "vega") return { vega: fieldsFor("vega"), sensitivityType: "Vega" };
  return {
    cvrUp: fieldsFor("cvr_up"),
    cvrDown: fieldsFor("cvr_down"),
    sensitivityType: "Curvature",
  };
}

// Wave 7.0.2.B — lazy-math weight resolution. Mirrors
// `services/ingest/src/consumer.ts:legWeight` EXACTLY:
//   Vega / Curvature → always 1.0 regardless of schema-table presence.
//   Delta            → schema's `<class>_delta_weights`:
//                        constant  → single weight applied to every field.
//                        by_tenor  → per-tenor weights, aligned with the
//                                    per-tenor field list (perTenor classes
//                                    only — falls back to 0 otherwise).
//                        by_bucket → bucket-dependent; cannot be injected
//                                    into APPLY (no @bucket access there),
//                                    so the per-bucket sums are multiplied
//                                    by the bucket weight in the TS reducer.
// CRITICAL: `config/schema/frtb-default.yaml` has NO `equity_vega_weights`,
// `fx_vega_weights`, `commodity_vega_weights`, or any `*_curvature_weights`
// table. A naive schema lookup would either trip a `schema_missing_weights`
// 503 or silently substitute 0 and zero those legs. The Vega/Curvature
// short-circuit BEFORE the schema lookup is the only safe path.
export type WeightSpec =
  | { kind: "constant"; value: number }
  | { kind: "by_tenor"; values: number[] }
  | { kind: "by_bucket"; map: Record<string, number> };

export function resolveLazyMathWeights(
  schema: Schema,
  riskClass: string,
  leg: FastLeg,
  perTenor: boolean,
): WeightSpec {
  if (leg === "vega" || leg === "curvature") {
    return { kind: "constant", value: 1.0 };
  }
  const upper = riskClass.toUpperCase();
  const cls = schema.risk_classes[upper];
  const ref = cls?.risk_weights_ref;
  const table = ref ? schema.risk_weights[ref] : undefined;
  if (!table) return { kind: "constant", value: 0 };
  if ("constant" in table) return { kind: "constant", value: table.constant };
  if ("by_tenor" in table) {
    const nodes = cls?.tenor?.nodes;
    if (perTenor && nodes && nodes.length > 0) {
      const values = nodes.map((t) => table.by_tenor[t] ?? 0);
      return { kind: "by_tenor", values };
    }
    return { kind: "constant", value: 0 };
  }
  if ("by_bucket" in table) return { kind: "by_bucket", map: table.by_bucket };
  return { kind: "constant", value: 0 };
}

// Wave 7.0.2.B — per-field multiplier array for the lazy-math APPLY builders.
// Curvature legs ignore the cvrUp/cvrDown distinction here because the rule
// short-circuits to 1.0; for Delta perTenor classes the i-th entry aligns
// with the i-th per-tenor field (resolveSlimLegFields and resolveLazyMathWeights
// both iterate `cls.tenor.nodes` in declaration order).
function applyMultipliers(roots: string[], weights: WeightSpec | null): number[] {
  if (!weights) return roots.map(() => 1.0);
  if (weights.kind === "constant") return roots.map(() => weights.value);
  if (weights.kind === "by_tenor") return roots.map((_, i) => weights.values[i] ?? 0);
  // by_bucket: APPLY-side gets the raw value (multiplier 1); the per-bucket
  // weight is applied to the GROUPBY sums in the TS reducer.
  return roots.map(() => 1.0);
}

// Wave 7.0.2.B — render a numeric weight as an APPLY literal. Standard
// JS `toString` produces clean decimals for every weight in
// frtb-default.yaml (e.g. 0.017, 0.55) and falls back to scientific
// notation for extreme magnitudes — both are accepted by the
// RediSearch SEARCH_EXPR parser.
function formatWeightLiteral(w: number): string {
  return String(w);
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
// Wave 6.14b — fast-fast path: per-bucket rollup hashes maintained
// incrementally by ingest (Wave 6.14a). When present, the calc route reads
// `sum_ws` / `sum_ws_sq` (and `sum_ws_up{,_sq}` / `sum_ws_down{,_sq}` for
// Curvature) directly via HGETALL, bypassing FT.AGGREGATE entirely.
export const ROLLUP_PATH_ENGINE = "rollup" as const;

// Wave 6.39.B — explicit fallback gate. The rollup fast-fast path is the
// primary execution path; FT.AGGREGATE is only used when a discovered
// bucket has no rollup hash yet (still-warming target, ingest in flight,
// or a tuple genuinely outside the seen-set's coverage). In production
// we'd rather surface that as a hard 412 (with a pointer to
// /admin/calc-coverage) than silently absorb the cost of a 270-bucket
// FT.AGGREGATE fan-out — operators can flip CALC_ALLOW_FT_AGGREGATE=true
// to re-enable the fallback after they've confirmed the missing tuples
// are intentional. Dev/test default ON so the existing fast-path test
// surface stays green without per-case env wiring.
export class FtAggregateFallbackDisabledError extends Error {
  constructor(public readonly riskClass: string, public readonly leg: FastLeg) {
    super(
      `FT.AGGREGATE fallback is disabled (CALC_ALLOW_FT_AGGREGATE!=true). ` +
      `Bucket has no rollup hash for risk_class=${riskClass} leg=${leg}; ` +
      `see /admin/calc-coverage for the missing tuple.`,
    );
    this.name = "FtAggregateFallbackDisabledError";
  }
}

export function isFtAggregateAllowed(): boolean {
  const raw = process.env.CALC_ALLOW_FT_AGGREGATE;
  if (raw !== undefined && raw !== "") {
    const v = raw.toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  // Unset: default off in production so a missing rollup is loud; on in
  // dev/test so unit tests can keep exercising the FT.AGGREGATE path
  // without setting the flag per-suite.
  return process.env.NODE_ENV !== "production";
}

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
  // Wave 6.41.A — positive-include push-down. `@field:{X|Y}` keeps only
  // rows whose value is IN the list (TAG `|` is OR). When bucket_subset is
  // also present, include.bucket combines as another @bucket:{...} clause
  // and the index parser intersects them.
  const inc = filters?.include;
  if (inc) {
    for (const key of ["book", "trade_id", "desk", "bucket"] as const) {
      const list = inc[key];
      if (list && list.length > 0) {
        parts.push(`@${key}:{${list.map(escapeTag).join("|")}}`);
      }
    }
  }
  const ex = filters?.exclude;
  if (ex) {
    // Wave 6.41.A — desk + bucket added to the exclude push-down list.
    for (const key of ["book", "trade_id", "risk_factor", "desk", "bucket"] as const) {
      const list = ex[key];
      if (list && list.length > 0) {
        parts.push(`-@${key}:{${list.map(escapeTag).join("|")}}`);
      }
    }
  }
  return parts.join(" ");
}

export {
  FT_AGGREGATE_TIMEOUT_MS,
  resolveLegFields,
  resolveRho,
  resolveQueryNodes,
  resolveSlimLegFields,
};

// Wave 5.96A — render an FT.AGGREGATE argv as a copy-pasteable command string
// for the per-bucket drilldown's "Redis command" block. Tokens containing
// whitespace are single-quoted; existing single quotes are escaped using the
// shell-safe `'\''` form. The output is informational (the route does not
// execute the rendered string), so we deliberately mirror what a developer
// would paste into `redis-cli`.
export function formatRedisCommand(name: string, argv: ReadonlyArray<unknown>): string {
  const out = [name];
  for (const a of argv) {
    const s = String(a);
    if (s === "" || /[\s'"]/.test(s)) {
      out.push(`'${s.replace(/'/g, "'\\''")}'`);
    } else {
      out.push(s);
    }
  }
  return out.join(" ");
}

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
// indexed field to 0 before driving every downstream APPLY + REDUCE off the
// safe alias.
// Wave 5.83J3 — extended the coalesce to the scalar classes (EQUITY / FX /
// Curvature). The live 5.84A/B throughput smokes can write rows where the
// per-class `ws_*` field never lands (ingest-side pollution), and the bare
// `@ws_equity_delta` / `@ws_fx_delta` reference tripped the same EXISTS
// error J1 fixed for GIRR. The `perTenor` parameter is retained for the
// public signature but no longer gates the safe-alias rewrite.
// Wave 6.39.H — switched the coalesce from the prior `case`/`exists`-based
// expression to an explicit `LOAD <n> @f1 @f2 …` + `APPLY @f+0 AS <f>_safe`.
// RediSearch 2.10.x marks the `case` function UNSTABLE and Redis Enterprise /
// Cloud gates it behind `ENABLE_UNSTABLE_FEATURES` (which clients cannot
// toggle), so the old shape 500s there. Arithmetic on a missing numeric HASH
// field coerces to 0 under `+`, giving identical semantics on every
// RediSearch flavor at the time.
// Wave 6.41.E.fix5 — neither shape works on both flavours any more. davpin
// (RediSearch 8.6.6) tightened the SEARCH_EXPR parser and now rejects
// `@field+0` in APPLY with `Syntax error at offset 17 near '+0'`. localcluster
// (RediSearch 2.10.27) still gates `case(exists(...),...)` behind
// ENABLE_UNSTABLE_FEATURES and cannot be flipped at runtime (FT.CONFIG and
// CONFIG SET both rejected against Redis Enterprise/Cloud). Other candidates
// were ruled out too — `coalesce` / `if` are unknown functions on both, and
// `to_number(@f)` throws on a missing field. Branch on the connected
// cluster's search module version (resolved once per RedisLike by
// `getSearchModuleMajorVersion`) so each cluster sees the form it accepts.
// DO NOT collapse this back to a single path — the historical context above
// is the reason the two-branch shape exists.
function nullCoerceApplyExpr(field: string, searchVer: number): string {
  // RediSearch 8.x: the legacy `@f+0` arithmetic null-coercion was removed
  // from the SEARCH_EXPR parser; `case(exists(...),...)` is the supported
  // replacement on the same versions where the unstable-feature gate has
  // been lifted.
  if (searchVer >= 80000) return `case(exists(@${field}),@${field},0)`;
  // Everything else (2.10.x, unknown / undetected ⇒ 0) gets the historical
  // arithmetic shape. The Wave 6.39.H comment above documents why this
  // form is needed on Enterprise / Cloud builds of RediSearch 2.x.
  return `@${field}+0`;
}

export function buildFastPathAggregateArgs(
  query: string,
  fields: LegFields,
  perTenor: boolean,
  indexName: string,
  searchVer: number,
  // Wave 7.0.2.B — optional per-leg weight spec used by the lazy-math fast
  // path. When provided, the `_safe` alias resolves to the WEIGHTED value
  // (raw `s_*` field × weight literal) instead of the bare null-coerced
  // field. `by_bucket` shapes leave the APPLY as raw and rely on the TS
  // reducer to multiply the GROUPBY sums by the per-bucket weight, because
  // APPLY has no @bucket access. Unset weights (default) preserve the
  // pre-7.0.2.B behaviour byte-for-byte — existing fat-path callers stay
  // unaffected.
  weights?: { delta?: WeightSpec; vega?: WeightSpec; curvature?: WeightSpec } | null,
): unknown[] {
  void perTenor;
  const args: unknown[] = [indexName, query];
  const loadFields: string[] = [];
  const loadSeen = new Set<string>();
  const applyClauses: Array<[string, string]> = [];
  const sumReducers: Array<[string, string]> = [];
  const safeRef = (f: string, multiplier: number): string => {
    const alias = `${f}_safe`;
    if (!loadSeen.has(f)) {
      loadSeen.add(f);
      loadFields.push(f);
    }
    const base = nullCoerceApplyExpr(f, searchVer);
    const expr = multiplier === 1.0 ? base : `(${base}*${formatWeightLiteral(multiplier)})`;
    applyClauses.push([expr, alias]);
    return alias;
  };
  const addNumericLeg = (roots: string[], prefix: string, mults: number[]): void => {
    for (let i = 0; i < roots.length; i++) {
      const f = roots[i]!;
      const safe = safeRef(f, mults[i] ?? 1.0);
      const sqAlias = `${prefix}_${f}_sq`;
      applyClauses.push([`(@${safe}*@${safe})`, sqAlias]);
      sumReducers.push([safe, `sum_${prefix}_${f}`]);
      sumReducers.push([sqAlias, `sum_${prefix}_${f}_sq`]);
    }
  };
  const addCurvatureLeg = (roots: string[], prefix: string, mults: number[]): void => {
    for (let i = 0; i < roots.length; i++) {
      const f = roots[i]!;
      const safe = safeRef(f, mults[i] ?? 1.0);
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
  const deltaW = weights?.delta ?? null;
  const vegaW = weights?.vega ?? null;
  const curvW = weights?.curvature ?? null;
  if (fields.delta) addNumericLeg(fields.delta, "d", applyMultipliers(fields.delta, deltaW));
  if (fields.vega) addNumericLeg(fields.vega, "v", applyMultipliers(fields.vega, vegaW));
  if (fields.cvrUp) addCurvatureLeg(fields.cvrUp, "u", applyMultipliers(fields.cvrUp, curvW));
  if (fields.cvrDown) addCurvatureLeg(fields.cvrDown, "n", applyMultipliers(fields.cvrDown, curvW));
  if (loadFields.length > 0) {
    args.push("LOAD", String(loadFields.length));
    for (const f of loadFields) args.push(`@${f}`);
  }
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

// Wave 5.96A.1 — components aggregate. Groups by (@bucket, @risk_factor) so the
// reducer can surface per-risk-factor WS (and CVR up/down) sums alongside the
// per-bucket totals the main aggregate produces. Reused by both /calc/sbm
// (top-N pairs) and the bucket-cross-detail endpoint (all pairs).
export function buildComponentsAggregateArgs(
  query: string,
  fields: LegFields,
  indexName: string,
  searchVer: number,
  // Wave 7.0.2.B — see `buildFastPathAggregateArgs` for the weight-injection
  // contract; same semantics here for the per-(bucket, risk_factor) reducer.
  weights?: { delta?: WeightSpec; vega?: WeightSpec; curvature?: WeightSpec } | null,
): unknown[] {
  const args: unknown[] = [indexName, query];
  // Wave 6.39.H / Wave 6.41.E.fix5 — version-aware null-coercion: see the
  // comment block above `buildFastPathAggregateArgs` for why the choice
  // between `case(exists(@f),@f,0)` (RediSearch 8.x) and `@f+0` (2.10.x)
  // is gated on the live `searchVer`.
  const loadFields: string[] = [];
  const loadSeen = new Set<string>();
  const applyClauses: Array<[string, string]> = [];
  const sumReducers: Array<[string, string]> = [];
  const safeRef = (f: string, multiplier: number): string => {
    const alias = `${f}_safe`;
    if (!loadSeen.has(f)) {
      loadSeen.add(f);
      loadFields.push(f);
    }
    const base = nullCoerceApplyExpr(f, searchVer);
    const expr = multiplier === 1.0 ? base : `(${base}*${formatWeightLiteral(multiplier)})`;
    applyClauses.push([expr, alias]);
    return alias;
  };
  const addLeg = (roots: string[], prefix: string, mults: number[]): void => {
    for (let i = 0; i < roots.length; i++) {
      const f = roots[i]!;
      const safe = safeRef(f, mults[i] ?? 1.0);
      const sqAlias = `${prefix}_${f}_sq`;
      applyClauses.push([`(@${safe}*@${safe})`, sqAlias]);
      sumReducers.push([safe, `sum_${prefix}_${f}`]);
      sumReducers.push([sqAlias, `sum_${prefix}_${f}_sq`]);
    }
  };
  const deltaW = weights?.delta ?? null;
  const vegaW = weights?.vega ?? null;
  const curvW = weights?.curvature ?? null;
  if (fields.delta) addLeg(fields.delta, "d", applyMultipliers(fields.delta, deltaW));
  if (fields.vega) addLeg(fields.vega, "v", applyMultipliers(fields.vega, vegaW));
  if (fields.cvrUp) addLeg(fields.cvrUp, "u", applyMultipliers(fields.cvrUp, curvW));
  if (fields.cvrDown) addLeg(fields.cvrDown, "n", applyMultipliers(fields.cvrDown, curvW));
  if (loadFields.length > 0) {
    args.push("LOAD", String(loadFields.length));
    for (const f of loadFields) args.push(`@${f}`);
  }
  for (const [expr, alias] of applyClauses) {
    args.push("APPLY", expr, "AS", alias);
  }
  args.push("GROUPBY", "2", "@bucket", "@risk_factor");
  for (const [src, alias] of sumReducers) {
    args.push("REDUCE", "SUM", "1", `@${src}`, "AS", alias);
  }
  args.push("LIMIT", "0", "100000");
  args.push("DIALECT", "2");
  args.push("TIMEOUT", String(FT_AGGREGATE_TIMEOUT_MS));
  return args;
}

// Parse a (bucket, risk_factor) keyed FT.AGGREGATE reply. Same RESP2/RESP3
// tolerance as parseAggregateRows; the outer key is `bucket`, the inner key
// is `risk_factor`.
export function parsePerRfRows(
  reply: unknown,
): Map<string, Map<string, Record<string, string>>> {
  const out = new Map<string, Map<string, Record<string, string>>>();
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
    const rf = m.risk_factor;
    if (!bucket || !rf) continue;
    let bm = out.get(bucket);
    if (!bm) { bm = new Map(); out.set(bucket, bm); }
    const prev = bm.get(rf);
    if (!prev) {
      bm.set(rf, m);
    } else {
      const merged: Record<string, string> = { ...prev };
      for (const [k, v] of Object.entries(m)) {
        if (k === "bucket" || k === "risk_factor") continue;
        const cur = Number(merged[k] ?? 0);
        merged[k] = String(cur + Number(v));
      }
      bm.set(rf, merged);
    }
  }
  return out;
}

// Wave 5.96A.1 — extract the tenor token from a ws_<class>_<leg>_<tenor> field
// alias. perTenor classes encode the tenor as the final underscore-separated
// segment; non-perTenor classes have no trailing tenor and this returns the
// raw field name.
function tenorFromField(f: string): string {
  const parts = f.split("_");
  return parts[parts.length - 1] ?? f;
}

// Wave 6.39.J — finite-only Number coercion for FT.AGGREGATE row values.
// `Number(undefined) === NaN` is already caught by the `?? 0` pattern, but
// `Number("nan")` / `Number("NaN")` is also NaN — RediSearch's SUM reducer
// can surface that token on Enterprise / Cloud builds when the input
// columns were sparse-tenor (every contributing row was missing the field).
// Without a guard the NaN propagates through K_b/S_b → reduceRiskClassCharge,
// and the response body either ships nulls (Fastify default serializer
// rewrites NaN to null) or trips a 500 under a strict serializer. Collapse
// any non-finite value to 0 so a sparse-tenor row resolves to K_b=0 — the
// same shape the rollup fast-fast path produces when no contributing tenor
// carries weight. Behaviour on well-formed numeric strings is unchanged.
function safeNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Wave 5.96A.1 — assemble ws_components + cross_components from per-tenor sums
// (perTenor classes) or from a per-(bucket, risk_factor) component map
// (scalar classes). `crossTopN === null` returns all ordered pairs; otherwise
// the list is sorted descending by |contrib| and truncated to the cap.
function buildDeltaVegaComponents(
  bucket: string,
  row: Record<string, string>,
  list: string[],
  prefix: "d" | "v",
  rho: number,
  perTenor: boolean,
  perRf: Map<string, Record<string, string>> | null,
  crossTopN: number | null,
): {
  ws_components: WsComponent[];
  cross_components: CrossComponent[];
  cross_components_truncated: boolean;
  cross_components_total_count: number;
} {
  void bucket;
  const ws: WsComponent[] = [];
  if (perTenor) {
    for (const f of list) {
      const k = tenorFromField(f);
      const wsVal = safeNum(row[`sum_${prefix}_${f}`]);
      // Delta perTenor: ws_squared_sum = Σ_tenor (per-tenor sum)² (mirrors
      // girr_delta.lua). Vega perTenor: ws_squared_sum = Σ_tenor (per-row sq).
      const wsSq = prefix === "d"
        ? wsVal * wsVal
        : safeNum(row[`sum_${prefix}_${f}_sq`]);
      ws.push({ k, ws: wsVal, ws_squared: wsSq });
    }
  } else if (perRf) {
    const f = list[0]!;
    for (const [rf, m] of perRf) {
      const wsVal = safeNum(m[`sum_${prefix}_${f}`]);
      const wsSq = safeNum(m[`sum_${prefix}_${f}_sq`]);
      ws.push({ k: rf, ws: wsVal, ws_squared: wsSq });
    }
    ws.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  }
  const cross = buildCrossComponents(ws, rho, crossTopN);
  return {
    ws_components: ws,
    cross_components: cross.list,
    cross_components_truncated: cross.truncated,
    cross_components_total_count: cross.total,
  };
}

function buildCrossComponents(
  ws: WsComponent[],
  rho: number,
  topN: number | null,
): { list: CrossComponent[]; total: number; truncated: boolean } {
  // Ordered pairs (k, l), k != l — matches the off-diagonal sum convention the
  // existing cross_term reducer uses (cross_term = ρ·(S² − ΣWS²) over per-
  // component sums). Σ_pairs contrib equals cross_term within rounding when
  // components are derived from the same aggregate level (per-tenor for GIRR
  // or per-RF for scalar classes with single-row-per-RF data).
  const all: CrossComponent[] = [];
  for (let i = 0; i < ws.length; i++) {
    for (let j = 0; j < ws.length; j++) {
      if (i === j) continue;
      const a = ws[i]!;
      const b = ws[j]!;
      all.push({ k: a.k, l: b.k, rho, ws_k: a.ws, ws_l: b.ws, contrib: rho * a.ws * b.ws });
    }
  }
  all.sort((x, y) => Math.abs(y.contrib) - Math.abs(x.contrib));
  const total = all.length;
  if (topN === null || total <= topN) {
    return { list: all, total, truncated: false };
  }
  return { list: all.slice(0, topN), total, truncated: true };
}

// Wave 5.96A.1 — build cvr_components for a single bucket. perTenor classes
// pair up the cvrUp/cvrDown per-tenor sums by index; scalar classes pair them
// via the per-RF component map (RFs that contributed to only one direction
// surface 0 on the other side).
function buildCurvatureComponents(
  fields: LegFields,
  row: Record<string, string>,
  perTenor: boolean,
  perRf: Map<string, Record<string, string>> | null,
): CvrComponent[] {
  const out: CvrComponent[] = [];
  if (perTenor) {
    const up = fields.cvrUp ?? [];
    const dn = fields.cvrDown ?? [];
    const n = Math.max(up.length, dn.length);
    for (let i = 0; i < n; i++) {
      const uf = up[i];
      const df = dn[i];
      const k = uf ? tenorFromField(uf) : df ? tenorFromField(df) : `t${i}`;
      const cvr_up = uf ? safeNum(row[`sum_u_${uf}`]) : 0;
      const cvr_down = df ? safeNum(row[`sum_n_${df}`]) : 0;
      out.push({ k, cvr_up, cvr_down });
    }
    return out;
  }
  if (!perRf) return out;
  const uf = fields.cvrUp?.[0];
  const df = fields.cvrDown?.[0];
  for (const [rf, m] of perRf) {
    const cvr_up = uf ? safeNum(m[`sum_u_${uf}`]) : 0;
    const cvr_down = df ? safeNum(m[`sum_n_${df}`]) : 0;
    out.push({ k: rf, cvr_up, cvr_down });
  }
  out.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return out;
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
// Wave 5.96A — returns ws_squared_sum (ΣWS²) and cross_term (ρ·Σ_{k≠l} WS_k·WS_l)
// alongside K_b so the per-bucket drilldown UI can render the substituted
// formula without re-deriving the intermediates.
function kbFromConstantRho(
  sumWs: number,
  sumWsSq: number,
  rho: number,
): { K_b: number; ws_squared_sum: number; cross_term: number } {
  let cross = sumWs * sumWs - sumWsSq;
  if (cross < 0) cross = 0;
  const cross_term = rho * cross;
  let kbSq = sumWsSq + cross_term;
  if (kbSq < 0) kbSq = 0;
  return { K_b: Math.sqrt(kbSq), ws_squared_sum: sumWsSq, cross_term };
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
): { K_b: number; S_b: number; ws_squared_sum: number; cross_term: number } {
  if (perTenor) {
    // Per-tenor classes (GIRR): K_b² operates on the per-tenor SUMs across rows
    // (mirroring girr_curvature.lua), so use the ψ-aware kernel from the shared
    // curvature oracle directly. The sign-split aggregates are unused.
    // Wave 5.96A — also surface ΣCVR² and the residual cross term so the UI
    // formula block can render the same closed-form pieces the kernel sees.
    const cvr = fields.map((f) => safeNum(row[`sum_${prefix}_${f}`]));
    const kbSq = Math.max(0, kbSquaredForDirection(cvr, rhoCurv));
    const S_b = cvr.reduce((a, b) => a + b, 0);
    const ws_squared_sum = cvr.reduce((acc, x) => acc + x * x, 0);
    // K_b² = ΣCVR² + cross_term → cross_term = K_b² − ΣCVR² (already ψ-gated
    // and scaled by ρ_curv inside kbSquaredForDirection).
    const cross_term = kbSq - ws_squared_sum;
    return { K_b: Math.sqrt(kbSq), S_b, ws_squared_sum, cross_term };
  }
  // Scalar classes (Equity / FX): each row is its own factor k. ψ gates on
  // (row_k, row_l); the sign-split decomposition lets us recover the gated
  // cross term from per-bucket aggregates without per-row data:
  //   Σ_{k≠l} a_k a_l                     = S² − SQ
  //   Σ_{k<0,l<0,k≠l} a_k a_l             = N² − SQN
  //   ψ-gated cross = total − both-negative
  const f = fields[0]!;
  const S = safeNum(row[`sum_${prefix}_${f}`]);
  const SQ = safeNum(row[`sum_${prefix}_${f}_sq`]);
  const N = safeNum(row[`sum_${prefix}_${f}_neg`]);
  const SQN = safeNum(row[`sum_${prefix}_${f}_negsq`]);
  const totalCross = S * S - SQ;
  const negCross = N * N - SQN;
  const gatedCross = totalCross - negCross;
  const cross_term = rhoCurv * gatedCross;
  const kbSq = Math.max(0, SQ + cross_term);
  return { K_b: Math.sqrt(kbSq), S_b: S, ws_squared_sum: SQ, cross_term };
}

// Per-bucket reducer: pulls the right aggregates from a single GROUPBY row and
// returns a BucketResult shaped exactly like the FCALL reply parser does.
// Wave 5.96A.1 — optional `perRfRow` (per-(bucket, risk_factor) sums) and
// `components` opts let the reducer attach ws_components / cross_components /
// cvr_components to the returned intermediate. perTenor classes derive
// components from the same `row`; scalar classes consume `perRfRow`.
function bucketResultFromRow(
  row: Record<string, string>,
  fields: LegFields,
  leg: FastLeg,
  rho: number,
  perTenor: boolean,
  startNs: bigint,
  perRfRow: Map<string, Record<string, string>> | null = null,
  components: ComponentsOpts | undefined = undefined,
): BucketResult {
  const bucket = row.bucket ?? "";
  const count = safeNum(row.row_count);
  const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
  if (leg === "delta" || leg === "vega") {
    const list = (leg === "delta" ? fields.delta : fields.vega) ?? [];
    const prefix: "d" | "v" = leg === "delta" ? "d" : "v";
    let sumWs: number;
    let sumWsSq: number;
    if (perTenor && leg === "delta") {
      // GIRR Delta: sum_ws_sq operates on the per-tenor SUMs (not the per-row
      // squared sums) — see girr_delta.lua. Square the per-tenor totals in TS.
      const wsK = list.map((f) => safeNum(row[`sum_d_${f}`]));
      sumWs = wsK.reduce((a, b) => a + b, 0);
      sumWsSq = wsK.reduce((acc, x) => acc + x * x, 0);
    } else {
      // Per-row sum_ws_sq matches the *_vega.lua and equity/fx_delta.lua shape.
      sumWs = 0;
      sumWsSq = 0;
      for (const f of list) {
        sumWs += safeNum(row[`sum_${prefix}_${f}`]);
        sumWsSq += safeNum(row[`sum_${prefix}_${f}_sq`]);
      }
    }
    const r = kbFromConstantRho(sumWs, sumWsSq, rho);
    const intermediate: BucketIntermediate = {
      path: "fast",
      ws_squared_sum: r.ws_squared_sum,
      cross_term: r.cross_term,
    };
    if (components) {
      const built = buildDeltaVegaComponents(
        bucket, row, list, prefix, rho, perTenor, perRfRow, components.crossTopN,
      );
      intermediate.ws_components = built.ws_components;
      intermediate.cross_components = built.cross_components;
      intermediate.cross_components_truncated = built.cross_components_truncated;
      intermediate.cross_components_total_count = built.cross_components_total_count;
    }
    return { bucket, K_b: r.K_b, S_b: sumWs, count, ms, intermediate };
  }
  // Curvature — pick the worse of K_b^+ / K_b^- per §21.5(3); S_b is the signed
  // Σ_k CVR_k of the winning direction (consumed by reduceCurvatureCharge).
  const up = kbCurvatureForDirection(row, fields.cvrUp ?? [], "u", rho, perTenor);
  const down = kbCurvatureForDirection(row, fields.cvrDown ?? [], "n", rho, perTenor);
  // Wave 5.96A — surface both raw K_b^± and the winner label, plus the winning
  // direction's ΣCVR² / cross term so the UI formula block can show the picked
  // scenario substituted (mirrors the §21.5(3) max selection).
  const winnerIsDown = down.K_b > up.K_b;
  const winner = winnerIsDown ? down : up;
  const curvatureInter: BucketIntermediate["curvature"] = {
    k_plus: up.K_b,
    k_minus: down.K_b,
    winner: winnerIsDown ? "minus" : "plus",
  };
  if (components) {
    curvatureInter.cvr_components = buildCurvatureComponents(fields, row, perTenor, perRfRow);
  }
  const intermediate: BucketIntermediate = {
    path: "fast",
    ws_squared_sum: winner.ws_squared_sum,
    cross_term: winner.cross_term,
    curvature: curvatureInter,
  };
  return { bucket, K_b: winner.K_b, S_b: winner.S_b, count, ms, intermediate };
}

// Wave 6.14b — pre-computed per-bucket rollup readout. Ingest (Wave 6.14a)
// maintains a hash per (risk_class, bucket, sensitivity_type) holding the
// running `sum_ws` / `sum_ws_sq` (and `sum_ws_up{,_sq}` / `sum_ws_down{,_sq}`
// for Curvature) plus `count`. The base key is hash-tagged on `<rc>:<bkt>`
// so it lives on the same shard as the per-bucket sens documents. GIRR
// additionally keeps per-tenor breakdowns at `…:tenor:<t>`.
//
// This function pipelines HGETALL across all requested buckets (+ tenors)
// via `Promise.all` so ioredis batches the requests on the wire. Returns the
// same `BucketResult[]` shape as `aggregateBucketsViaIndex` so the route
// drops the result in place. Any missing/incomplete hash collapses the
// entire batch to `null` (the caller falls back to FT.AGGREGATE) — partial
// rollups would silently drop buckets from the charge.
//
// Non-perTenor Curvature is intentionally unsupported: the 4 sign-split
// fields cannot reconstruct the ψ-gated cross term (which needs row-level
// negative-only sums). Such requests return `null` and route through the
// existing FT.AGGREGATE path.

// HGETALL reply parser tolerating both RESP2 flat key/value arrays and
// RESP3 map objects (in-process fakes). Returns `null` for empty/missing
// hashes so callers can detect "no rollup yet" without inspecting the
// shape themselves.
function parseHgetall(reply: unknown): Record<string, string> | null {
  if (reply === null || reply === undefined) return null;
  const out: Record<string, string> = {};
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    for (let i = 0; i < reply.length; i += 2) {
      out[String(reply[i])] = String(reply[i + 1]);
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  if (typeof reply === "object") {
    for (const [k, v] of Object.entries(reply as Record<string, unknown>)) {
      out[k] = String(v);
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

export async function tryRollupReadout(
  redis: RedisLike,
  schema: Schema,
  riskClass: string,
  leg: FastLeg,
  buckets: ReadonlyArray<string>,
  // Wave 6.47.A — opt-in per-component breakdown. perTenor (GIRR) classes
  // can derive ws_components / cvr_components from the same per-tenor map
  // the K_b math already iterates; cross_components are intentionally
  // omitted (the rollup hashes hold no per-(k,l) data — the lazy
  // /calc/sbm/bucket-cross-detail endpoint covers that surface).
  components: ComponentsOpts | undefined = undefined,
): Promise<BucketResult[] | null> {
  const start = process.hrtime.bigint();
  const rc = riskClass.toUpperCase();
  const cls = schema.risk_classes[rc];
  const perTenor = PER_TENOR_CLASSES.has(rc) && (cls?.tenor?.nodes?.length ?? 0) > 0;
  // Non-perTenor Curvature: rollup contract lacks ψ-gating data. Skip
  // entirely so the route falls back to FT.AGGREGATE.
  if (leg === "curvature" && !perTenor) return null;
  if (buckets.length === 0) return [];

  const fields = resolveLegFields(schema, rc, leg);
  const rho = resolveRho(schema, rc, leg);
  const sens = fields.sensitivityType;
  const tenors: ReadonlyArray<string> = perTenor ? cls!.tenor!.nodes : [""];

  // Build the HGETALL plan: one base key per bucket, plus per-tenor keys
  // for perTenor classes. Each entry tracks its (bucket, tenor) origin so
  // we can index the replies after Promise.all settles.
  type Lookup = { bucket: string; tenor: string; key: string };
  const lookups: Lookup[] = [];
  for (const b of buckets) {
    if (perTenor) {
      for (const t of tenors) lookups.push({ bucket: b, tenor: t, key: rollupKey(rc, b, sens, t) });
    } else {
      lookups.push({ bucket: b, tenor: "", key: rollupKey(rc, b, sens) });
    }
  }

  let replies: unknown[];
  try {
    replies = await Promise.all(lookups.map((l) => redis.call("HGETALL", l.key)));
  } catch {
    return null;
  }

  // Index parsed hashes by bucket (and tenor for perTenor classes). For
  // non-perTenor classes a missing base hash → bail and fall back to
  // FT.AGGREGATE (the only place that knows how to compute K_b without the
  // rollup). Wave 6.49.A — for perTenor (GIRR) classes the per-tenor
  // fields are sparse by construction (a 5Y risk factor only writes its
  // 5Y hash), so a missing `(bucket, tenor)` HGETALL is the normal
  // representation of "no contributions for that tenor" rather than a
  // signal to fall back; skip the insertion and let the bucket loop
  // treat the absent tenor as zero. If every tenor for a bucket comes
  // back empty the bucket simply has no entry in byBucket and we skip
  // it below — same answer FT.AGGREGATE would give if the field shape
  // weren't sparse.
  const byBucket = new Map<string, Map<string, Record<string, string>>>();
  for (let i = 0; i < lookups.length; i++) {
    const parsed = parseHgetall(replies[i]);
    const l = lookups[i]!;
    if (!parsed) {
      if (!perTenor) return null;
      continue;
    }
    let tm = byBucket.get(l.bucket);
    if (!tm) { tm = new Map(); byBucket.set(l.bucket, tm); }
    tm.set(l.tenor, parsed);
  }

  const out: BucketResult[] = [];
  for (const b of buckets) {
    const tm = byBucket.get(b);
    if (!tm) {
      // Wave 6.49.A — perTenor: every tenor empty → bucket has no data,
      // skip it from the output rather than poisoning the whole readout
      // (the route's caller already tolerates empty buckets). Non-perTenor:
      // preserve the existing "no base rollup → fall back" signal.
      if (perTenor) continue;
      return null;
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (leg === "delta" || leg === "vega") {
      let sumWs: number;
      let sumWsSq: number;
      let count = 0;
      // Wave 6.47.A — collect per-tenor (ws, ws_squared) so we can emit
      // ws_components when the caller opted in. Mirrors the field-naming
      // convention used by buildDeltaVegaComponents (tenor key, not field
      // alias) so the UI sort on GIRR_TENORS keeps working.
      const wsComponents: WsComponent[] | null = (components && perTenor) ? [] : null;
      if (perTenor && leg === "delta") {
        // GIRR Delta: ws_squared_sum operates on per-tenor SUMs (Σ_t (sum_ws_t)²),
        // mirroring girr_delta.lua / bucketResultFromRow. Wave 6.49.A —
        // sparse per-tenor hashes (a tenor with no contributions in this
        // bucket) contribute 0 to Σws / Σws²; the per-tenor ws_components
        // entry still emits with ws=0 so the UI sort over GIRR_TENORS keeps
        // a stable shape.
        sumWs = 0;
        sumWsSq = 0;
        for (const t of tenors) {
          const h = tm.get(t);
          const ws = Number(h?.sum_ws ?? 0);
          sumWs += ws;
          const wsSq = ws * ws;
          sumWsSq += wsSq;
          count += Number(h?.count ?? 0);
          if (wsComponents) wsComponents.push({ k: t, ws, ws_squared: wsSq });
        }
      } else if (perTenor) {
        // GIRR Vega: per-row sum_ws_sq summed across tenors. Wave 6.49.A —
        // sparse tenors contribute 0 (same shape as the Delta branch above).
        sumWs = 0;
        sumWsSq = 0;
        for (const t of tenors) {
          const h = tm.get(t);
          const ws = Number(h?.sum_ws ?? 0);
          const wsSq = Number(h?.sum_ws_sq ?? 0);
          sumWs += ws;
          sumWsSq += wsSq;
          count += Number(h?.count ?? 0);
          if (wsComponents) wsComponents.push({ k: t, ws, ws_squared: wsSq });
        }
      } else {
        // Scalar classes (Equity / FX): single hash carries all aggregates.
        const h = tm.get("");
        if (!h) return null;
        sumWs = Number(h.sum_ws ?? 0);
        sumWsSq = Number(h.sum_ws_sq ?? 0);
        count = Number(h.count ?? 0);
      }
      // Wave 6.39.B — bucket-level K_b cache. Scalar Delta/Vega caches the
      // computed K_b keyed by a SHA1 over the underlying rollup HVALS so a
      // content drift (HINCRBYFLOAT bumping sum_ws on the next ingest batch)
      // is detected on the next read and the entry is recomputed. perTenor
      // (GIRR) Delta/Vega and Curvature follow as a tracked follow-up — both
      // need preserving extra intermediate fields (per-tenor breakdown,
      // k_plus/k_minus winner) that don't fit a single scalar value.
      const r = kbFromConstantRho(sumWs, sumWsSq, rho);
      if (!perTenor) {
        const cacheKey = kbCacheKey(rc, b, sens, "default", "n_a");
        const contentHash = computeRollupContentHash(tm.get("") ?? {});
        const cached = await lookupKbCacheEntry(redis, cacheKey, contentHash);
        if (cached) {
          r.K_b = cached.K_b;
        } else {
          await storeKbCacheEntry(redis, cacheKey, r.K_b, contentHash);
        }
      }
      const intermediate: BucketIntermediate = {
        path: "fast",
        ws_squared_sum: r.ws_squared_sum,
        cross_term: r.cross_term,
      };
      // Wave 6.47.A — attach per-tenor ws breakdown when requested. Scalar
      // (non-perTenor) classes need a second FT.AGGREGATE grouped by
      // risk_factor that the rollup path doesn't run, so we deliberately
      // omit ws_components there rather than emit a half-truth.
      if (wsComponents) intermediate.ws_components = wsComponents;
      out.push({
        bucket: b,
        K_b: r.K_b,
        S_b: sumWs,
        count,
        ms,
        intermediate,
      });
      continue;
    }
    // Curvature perTenor (GIRR): per-tenor sum_ws_up / sum_ws_down vectors
    // drive the ψ-aware K_b ± via kbSquaredForDirection; pick the worse
    // direction per §21.5(3). S_b is the signed Σ_t CVR_t of the winner.
    // Wave 6.49.A — a sparse tenor (no contributions in this bucket) feeds
    // 0 into both cvrUp/cvrDown vectors at its schema-ordered slot so the
    // ψ-gate and tenor labels stay aligned.
    const cvrUp: number[] = [];
    const cvrDown: number[] = [];
    let count = 0;
    for (const t of tenors) {
      const h = tm.get(t);
      cvrUp.push(Number(h?.sum_ws_up ?? 0));
      cvrDown.push(Number(h?.sum_ws_down ?? 0));
      count += Number(h?.count ?? 0);
    }
    const kbUpSq = Math.max(0, kbSquaredForDirection(cvrUp, rho));
    const kbDownSq = Math.max(0, kbSquaredForDirection(cvrDown, rho));
    const kbUp = Math.sqrt(kbUpSq);
    const kbDown = Math.sqrt(kbDownSq);
    const winnerIsDown = kbDown > kbUp;
    const wsSq = winnerIsDown
      ? cvrDown.reduce((acc, x) => acc + x * x, 0)
      : cvrUp.reduce((acc, x) => acc + x * x, 0);
    const S_b = winnerIsDown
      ? cvrDown.reduce((a, c) => a + c, 0)
      : cvrUp.reduce((a, c) => a + c, 0);
    const curvatureInter: BucketIntermediate["curvature"] = {
      k_plus: kbUp,
      k_minus: kbDown,
      winner: winnerIsDown ? "minus" : "plus",
    };
    // Wave 6.47.A — attach per-tenor CVR breakdown when requested. The
    // tenor labels come straight from the schema-ordered `tenors` array
    // the cvrUp/cvrDown vectors were filled from, so the i-th entry
    // matches the i-th label.
    if (components) {
      const cvrComponents: CvrComponent[] = [];
      for (let i = 0; i < tenors.length; i++) {
        cvrComponents.push({
          k: tenors[i]!,
          cvr_up: cvrUp[i] ?? 0,
          cvr_down: cvrDown[i] ?? 0,
        });
      }
      curvatureInter.cvr_components = cvrComponents;
    }
    out.push({
      bucket: b,
      K_b: winnerIsDown ? kbDown : kbUp,
      S_b,
      count,
      ms,
      intermediate: {
        path: "fast",
        ws_squared_sum: wsSq,
        cross_term: (winnerIsDown ? kbDownSq : kbUpSq) - wsSq,
        curvature: curvatureInter,
      },
    });
  }
  // Wave 6.49.A — perTenor: if every requested bucket was skipped (all
  // tenors empty across the board) the rollup hashes have no coverage at
  // all for this (rc, leg) — fall back to FT.AGGREGATE rather than
  // returning an empty rollup that the route would mistake for a
  // successful "rollup with zero buckets" reply (`if (rollup)` on `[]` is
  // truthy in JS). Non-perTenor already returned null upstream on a
  // missing base hash, so this only matters for perTenor.
  if (perTenor && out.length === 0 && buckets.length > 0) return null;
  return out;
}

export async function aggregateBucketsViaIndex(opts: AggregateBucketsOpts): Promise<BucketResult[]> {
  // Wave 6.39.B — fail loud before any FT.AGGREGATE traffic when the
  // operator has disabled the fallback (prod default). The route catches
  // this and translates to 412 fallback-disabled.
  if (!isFtAggregateAllowed()) {
    throw new FtAggregateFallbackDisabledError(opts.riskClass.toUpperCase(), opts.leg);
  }
  const start = process.hrtime.bigint();
  const riskClass = opts.riskClass.toUpperCase();
  const lazyMath = opts.lazyMath === true;
  // Wave 7.0.2.B — slim variant uses `s_*` aliases; fat variant keeps `ws_*`.
  // The two share LegFields shape so the rest of the pipeline is agnostic.
  const fields = lazyMath
    ? resolveSlimLegFields(opts.schema, riskClass, opts.leg)
    : resolveLegFields(opts.schema, riskClass, opts.leg);
  const rho = resolveRho(opts.schema, riskClass, opts.leg);
  const perTenor = PER_TENOR_CLASSES.has(riskClass) && (opts.schema.risk_classes[riskClass]?.tenor?.nodes?.length ?? 0) > 0;
  const query = buildFastPathQuery(riskClass, fields.sensitivityType, opts.filters);
  // Wave 6.30.B2 — `indexName` is required on AggregateBucketsOpts so a
  // missed plumbing step now fails at compile time instead of silently
  // hitting the literal `idx:sens` against a versioned-only cluster.
  const indexName = opts.indexName;
  // Wave 6.41.E.fix5 — resolve the live search module major version once per
  // call so both this aggregate and the optional per-RF components aggregate
  // emit the APPLY null-coercion shape this cluster accepts. The helper
  // caches per-RedisLike so the lookup amortises across calls on the same
  // connection; a target swap rebuilds the pool client and naturally misses
  // the cache.
  const searchVer = await getSearchModuleMajorVersion(opts.redis);
  // Wave 7.0.2.B — resolve per-leg weights once. For non-lazy callers the
  // builders get `null` weights and emit the byte-identical pre-7.0.2.B
  // APPLY argv. For lazy callers the Vega/Curvature short-circuit to 1.0
  // happens inside `resolveLazyMathWeights` (the only safe place — see the
  // CRITICAL note in that helper's docblock).
  const weightSpec: WeightSpec | null = lazyMath
    ? resolveLazyMathWeights(opts.schema, riskClass, opts.leg, perTenor)
    : null;
  const builderWeights = lazyMath
    ? {
        delta: opts.leg === "delta" ? weightSpec! : undefined,
        vega: opts.leg === "vega" ? weightSpec! : undefined,
        curvature: opts.leg === "curvature" ? weightSpec! : undefined,
      }
    : null;
  const argv = buildFastPathAggregateArgs(query, fields, perTenor, indexName, searchVer, builderWeights);
  const nodes = resolveQueryNodes(opts.redis);
  const merged = new Map<string, Record<string, string>>();
  // Wave 5.96A.1 — scalar (non-perTenor) classes need a second FT.AGGREGATE
  // grouped by (@bucket, @risk_factor) to recover per-RF components; perTenor
  // (GIRR) already exposes per-tenor sums via the main aggregate.
  const needsPerRf = opts.components !== undefined && !perTenor;
  const perRfArgv = needsPerRf ? buildComponentsAggregateArgs(query, fields, indexName, searchVer, builderWeights) : null;
  const perRfMerged = new Map<string, Map<string, Record<string, string>>>();
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
    if (perRfArgv) {
      const perRfReply = await node.call("FT.AGGREGATE", ...perRfArgv);
      const perRfRows = parsePerRfRows(perRfReply);
      for (const [b, bm] of perRfRows) {
        let dst = perRfMerged.get(b);
        if (!dst) { dst = new Map(); perRfMerged.set(b, dst); }
        for (const [rf, m] of bm) {
          const prev = dst.get(rf);
          if (!prev) { dst.set(rf, m); continue; }
          const next: Record<string, string> = { ...prev };
          for (const [k, v] of Object.entries(m)) {
            if (k === "bucket" || k === "risk_factor") continue;
            const cur = Number(next[k] ?? 0);
            next[k] = String(cur + Number(v));
          }
          dst.set(rf, next);
        }
      }
    }
  }
  // Wave 7.0.2.B — by_bucket Delta weighting cannot be folded into APPLY
  // (APPLY runs before GROUPBY and has no @bucket binding for a per-row
  // weight lookup). Multiply the GROUPBY sums (and per-RF sums) by the
  // per-bucket weight here, in TS, before bucketResultFromRow consumes them.
  // For sum_d_<f> the multiplier is w; for sum_d_<f>_sq it is w² because the
  // underlying per-row Σ(s²) becomes Σ(w·s)² = w²·Σ(s²) for a per-bucket
  // (row-invariant) weight. Vega/Curvature short-circuit to constant 1.0 in
  // resolveLazyMathWeights, so this block is a no-op for those legs.
  if (lazyMath && weightSpec && weightSpec.kind === "by_bucket" && opts.leg === "delta" && fields.delta) {
    applyByBucketDeltaWeights(merged, perRfMerged, fields.delta, weightSpec.map);
  }
  const out: BucketResult[] = [];
  for (const row of merged.values()) {
    const b = row.bucket ?? "";
    const perRfRow = needsPerRf ? perRfMerged.get(b) ?? null : null;
    out.push(bucketResultFromRow(row, fields, opts.leg, rho, perTenor, start, perRfRow, opts.components));
  }
  return out;
}

// Wave 7.0.2.B — in-place post-multiplication of FT.AGGREGATE delta sums by
// the per-bucket weight. Pure / synchronous; called only when lazyMath is on
// and the resolved WeightSpec is `by_bucket`. The Number coercion mirrors
// `safeNum` so a missing / "nan" entry (sparse rows on Enterprise builds)
// stays at 0 rather than poisoning the bucket with NaN.
function applyByBucketDeltaWeights(
  merged: Map<string, Record<string, string>>,
  perRfMerged: Map<string, Map<string, Record<string, string>>>,
  deltaFields: ReadonlyArray<string>,
  weightMap: Record<string, number>,
): void {
  const scaleRow = (row: Record<string, string>, w: number): void => {
    const wSq = w * w;
    for (const f of deltaFields) {
      const sumKey = `sum_d_${f}`;
      const sqKey = `sum_d_${f}_sq`;
      if (row[sumKey] != null) {
        const n = Number(row[sumKey]);
        row[sumKey] = String(Number.isFinite(n) ? n * w : 0);
      }
      if (row[sqKey] != null) {
        const n = Number(row[sqKey]);
        row[sqKey] = String(Number.isFinite(n) ? n * wSq : 0);
      }
    }
  };
  for (const [bucket, row] of merged) {
    const w = weightMap[bucket] ?? 0;
    if (w === 1.0) continue;
    scaleRow(row, w);
  }
  for (const [bucket, bm] of perRfMerged) {
    const w = weightMap[bucket] ?? 0;
    if (w === 1.0) continue;
    for (const m of bm.values()) scaleRow(m, w);
  }
}

