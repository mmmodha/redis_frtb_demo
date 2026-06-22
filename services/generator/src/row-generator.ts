import { monotonicFactory } from "ulid";
import seedrandom from "seedrandom";
import type { Dimension, Schema, RiskClassConfig } from "@frtb/schema";
import { buildHashTag } from "@frtb/stream-router";

export type SensitivityRow = {
  risk_class: string;
  bucket: string;
  _hash_tag: string;
  _id: string;
  [field: string]: unknown;
};

export interface RowGeneratorOptions {
  seed?: number | string;
  /**
   * Sensitivity types to draw from when emitting rows. Default ["Delta","Vega"]
   * preserves pre-5.16d behaviour. Pass ["Curvature"] (or include it in the
   * mix) to emit shape-A Curvature rows: GIRR `{cvr_up: number[], cvr_down:
   * number[]}` per-tenor, Equity/FX `{cvr_up: number, cvr_down: number}` per
   * factor (mirrors the Delta scalar-vs-array convention per risk class).
   */
  sensitivityTypes?: readonly string[];
  /**
   * Wave 5.17a — tenant reshape. Trade-id pool size for the post-loop aux-RNG
   * draw. Defaults to 200 (matches the smoke-run-16 canonical 2000-row / 10
   * trades-per-id ratio). Aux-RNG is seeded with `seed + ':aux'` so the
   * main value-RNG sequence is unchanged — pre/post-reshape numeric outputs
   * are bit-identical.
   */
  tradePoolSize?: number;
  /**
   * Wave 5.17a — tenant reshape. Risk-factor pool size per class (default 16).
   * Emitted as `RF_<CLASS>_<NN>` via the aux RNG.
   */
  factorPoolSize?: number;
  /**
   * Wave 6.39.A — bucket sampling mode.
   *   • undefined (legacy): schema's `bucket_weights` if present, else uniform.
   *     Preserves bit-equivalence with pre-6.39.A fixtures.
   *   • "uniform":   every bucket equally likely regardless of schema weights.
   *   • "realistic": 5/15/80 split across the bucket list's first/middle/last
   *     thirds (FRTB book shape — see docs/generator-distribution.md).
   *   • "pareto":    schema's `bucket_weights` (or uniform when absent).
   * All branches consume exactly one rng() tick per bucket pick so the
   * rng-isolation canary (existing) continues to hold.
   */
  distribution?: "uniform" | "realistic" | "pareto";
  /**
   * Wave 7.0.6.19 — sensitivity_type coverage floor. When set to N > 0 and
   * `sensitivityTypes.length > 1`, the first N draws of each sensitivity_type
   * for a given risk_class are FORCED in declared order (Delta, Vega,
   * Curvature, …) before the loop reverts to the uniform-random pick. This
   * guarantees every `(risk_class, sensitivity_type)` combo gets ≥ N rows so
   * small smoke runs (rows=50k) reliably contain GIRR Curvature etc. — the
   * verifier's 5-combo calc smoke gate is meaningful.
   *
   * The floor consumes one rng() tick per row (same as the uniform path) so
   * the rng-isolation canary holds for the no-floor default (undefined / 0).
   * Callers compute N = max(1, floor(rowsTotal / 100)) when rowsTotal >= 100;
   * multi-worker callers divide by stride so the aggregate ≥ the global floor.
   */
  coverageFloor?: number;
  /**
   * Wave 7.0.6.20 — pre-planned per-class row counts for the reallocation-
   * based coverage floor. When provided alongside `coverageFloor > 0` and
   * `sensitivityTypes.length > 1`, the generator pre-computes a per-(rc,
   * sens_type) quota table that:
   *   1. starts from a uniform split (rows/N per sens_type, with the integer
   *      remainder distributed to the lowest-index combos);
   *   2. raises any below-`coverageFloor` combo up to the floor by STEALING
   *      from the largest combo (effective floor capped at floor(rows/N) so
   *      the table is always realisable);
   *   3. sums to exactly the planned per-class row count — preserving the
   *      requested total instead of inflating it the way the 6.19 bias-on-
   *      pick path could when the floor exceeded the natural share.
   * Each `generate(rc)` call then picks the sens_type with the largest
   * remaining quota and decrements it. The pick still consumes exactly one
   * `rng()` tick per row (ignored when a quota table exists) so the rng-
   * isolation canary holds for any seed. Callers that don't pass this fall
   * back to the legacy 6.19 bias-on-pick path (floor guarantee, no row-count
   * preservation contract).
   */
  plannedRowsByClass?: Readonly<Record<string, number>>;
}

export type DistributionMode = NonNullable<RowGeneratorOptions["distribution"]>;

export interface RowGenerator {
  generate(riskClass: string): SensitivityRow;
}

const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega"] as const;
const DEFAULT_TRADE_POOL_SIZE = 200;
const DEFAULT_FACTOR_POOL_SIZE = 16;

// Wave 6.38.A — 15-desk taxonomy (5 asset classes × 3 regions). Underscore
// separator keeps `FT.SEARCH idx:sens "@desk:{RATES_LDN}"` unescaped. The
// asset-class half is selected by mapping the row's `risk_class` to the
// natural affinity (GIRR→RATES, EQUITY→EQUITY, FX→FX, fallback RATES); the
// region half is drawn from the aux RNG so re-runs with the same seed
// produce stable desks, and the main value-RNG sequence is unchanged.
const DESK_ASSET_CLASS_BY_RC: Readonly<Record<string, string>> = Object.freeze({
  GIRR: "RATES",
  EQUITY: "EQUITY",
  FX: "FX",
  CREDIT: "CREDIT",
  COMMODITY: "COMMODITY",
});
const DESK_REGIONS = ["LDN", "NYC", "HKG"] as const;

// Per-dimension op codes — resolved once per schema, then executed per row.
type Op =
  | { k: "risk_class"; name: string }
  | { k: "bucket"; name: string }
  | { k: "sens_type"; name: string }
  | { k: "tenor_array"; name: string }
  | { k: "tenor_pick"; name: string }
  | { k: "rv_array"; name: string; len: number }
  | { k: "rv_scalar"; name: string }
  | { k: "weight_const"; name: string; value: number }
  | { k: "weight_by_tenor"; name: string; values: number[] }
  | { k: "weight_by_bucket"; name: string; table: Record<string, number> }
  | { k: "tag"; name: string; prefix: string; card: number }
  | { k: "numeric"; name: string }
  | { k: "array_numeric"; name: string; len: number };

interface ClassPlan {
  buckets: readonly string[];
  tenorNodes?: readonly string[];
  ops: Op[];
  // Wave 5.47a — when the schema provides `risk_classes.<C>.bucket_weights`,
  // we precompute the cumulative distribution over `buckets` so the per-row
  // bucket pick consumes exactly one rng() draw — same call-count as the
  // uniform `(rng() * buckets.length) | 0` it replaces, preserving the
  // main-rng tick budget for downstream rv_*/tag/numeric ops. Absent buckets
  // get weight 0; missing or all-zero map → falls back to uniform.
  bucketCdf?: number[];
  bucketCdfTotal?: number;
}

export function createRowGenerator(
  schema: Schema,
  opts: RowGeneratorOptions = {}
): RowGenerator {
  const seedStr = String(opts.seed ?? 0);
  const rng = seedrandom(seedStr);
  // Wave 5.17a — aux RNG for tenant fields (trade_id, risk_factor). Seeded
  // with `<seed>:aux` so it cannot collide with or perturb the main value
  // RNG. CRITICAL: never call rng() (the main stream) from the tenant-field
  // path — that would shift every downstream numeric draw and break the
  // pre-reshape vs post-reshape byte-equivalence invariant.
  const auxRng = seedrandom(seedStr + ":aux");
  const tradePoolSize = Math.max(1, Math.floor(opts.tradePoolSize ?? DEFAULT_TRADE_POOL_SIZE));
  const factorPoolSize = Math.max(1, Math.floor(opts.factorPoolSize ?? DEFAULT_FACTOR_POOL_SIZE));
  const ulid = monotonicFactory();
  const sensTypes = opts.sensitivityTypes && opts.sensitivityTypes.length > 0
    ? opts.sensitivityTypes
    : DEFAULT_SENSITIVITY_TYPES;
  // Wave 7.0.6.19 — per-(risk_class, sensitivity_type) emission counters
  // backing the coverage-floor guarantee. Lazily initialised per class on
  // first draw; only consulted when `coverageFloor > 0 && sensTypes.length
  // > 1` so the no-floor default path stays a single bounds-check + bitwise
  // index pick (preserves the rng-isolation canary).
  const coverageFloor = Math.max(0, Math.floor(opts.coverageFloor ?? 0));
  const sensCountsByClass: Map<string, number[]> = new Map();
  // Wave 7.0.6.20 — pre-computed per-class quota tables for the reallocation
  // path. Built once from `plannedRowsByClass`; classes absent from the map
  // (or with non-positive counts) fall back to the 6.19 bias-on-pick path
  // so callers that haven't migrated still get the floor guarantee.
  let quotasByClass: Map<string, number[]> | undefined;
  if (coverageFloor > 0 && sensTypes.length > 1 && opts.plannedRowsByClass) {
    quotasByClass = new Map();
    for (const cls of Object.keys(opts.plannedRowsByClass)) {
      const planned = Math.floor(opts.plannedRowsByClass[cls] ?? 0);
      if (planned > 0) {
        quotasByClass.set(cls, computeCoverageQuotas(planned, sensTypes.length, coverageFloor));
      }
    }
  }
  const dimsByName = new Map<string, Dimension>();
  for (const d of schema.dimensions) dimsByName.set(d.name, d);
  const binding = schema.frtb_binding;
  const plans = new Map<string, ClassPlan>();

  function planFor(riskClass: string): ClassPlan {
    let plan = plans.get(riskClass);
    if (plan) return plan;
    const cls: RiskClassConfig | undefined = schema.risk_classes[riskClass];
    if (!cls) {
      const known = Object.keys(schema.risk_classes).join(", ");
      throw new Error(`risk class ${riskClass} not defined in schema (known: ${known})`);
    }
    const tenorNodes = cls.tenor?.nodes;
    const ops: Op[] = [];
    for (const dimName of cls.dimensions) {
      const dim = dimsByName.get(dimName);
      if (!dim) continue;
      if (dimName === binding.risk_class) { ops.push({ k: "risk_class", name: dimName }); continue; }
      if (dimName === binding.bucket) { ops.push({ k: "bucket", name: dimName }); continue; }
      if (dimName === binding.sensitivity_type) { ops.push({ k: "sens_type", name: dimName }); continue; }
      if (dimName === binding.tenor) {
        // GIRR convention: tenor emitted as full array curve alongside ARRAY_NUMERIC risk_value.
        const asArray = dim.type === "ARRAY_NUMERIC" || (dim.type === "TAG" && tenorNodes && tenorNodes.length > 1);
        ops.push({ k: asArray ? "tenor_array" : "tenor_pick", name: dimName });
        continue;
      }
      if (dimName === binding.risk_value) {
        if (dim.type === "ARRAY_NUMERIC" && tenorNodes && tenorNodes.length > 1) {
          ops.push({ k: "rv_array", name: dimName, len: tenorNodes.length });
        } else {
          ops.push({ k: "rv_scalar", name: dimName });
        }
        continue;
      }
      if (dimName === binding.weight) {
        const ref = cls.risk_weights_ref;
        const table = ref ? schema.risk_weights[ref] : undefined;
        if (table && "constant" in table) ops.push({ k: "weight_const", name: dimName, value: table.constant });
        else if (table && "by_tenor" in table && tenorNodes) ops.push({ k: "weight_by_tenor", name: dimName, values: tenorNodes.map((t) => table.by_tenor[t] ?? 0) });
        else if (table && "by_bucket" in table) ops.push({ k: "weight_by_bucket", name: dimName, table: table.by_bucket });
        else ops.push({ k: "weight_const", name: dimName, value: 0 });
        continue;
      }
      if (dim.type === "TAG") {
        const card = typeof dim.cardinality_hint === "number" ? dim.cardinality_hint
          : typeof dim.cardinality_hint === "string" ? Number(dim.cardinality_hint) || 16 : 16;
        ops.push({ k: "tag", name: dimName, prefix: `${dimName}_${riskClass.toLowerCase()}_`, card });
      } else if (dim.type === "NUMERIC") {
        ops.push({ k: "numeric", name: dimName });
      } else if (dim.type === "ARRAY_NUMERIC") {
        ops.push({ k: "array_numeric", name: dimName, len: tenorNodes?.length ?? 1 });
      }
    }
    // Wave 6.39.A — distribution-aware bucket CDF resolution. Explicit
    // `distribution` overrides the schema; default (undefined) preserves
    // the legacy schema-first behaviour so all pre-6.39.A fixtures still
    // replay bit-for-bit (rng-isolation canary, weighted-fixture tests).
    let bucketCdf: number[] | undefined;
    let bucketCdfTotal: number | undefined;
    const dist = opts.distribution;
    const useUniform = dist === "uniform";
    const useRealistic = dist === "realistic";
    const useSchemaWeights = (dist === undefined || dist === "pareto") && !!cls.bucket_weights;
    if (useRealistic) {
      // 5/15/80 split across sparse/medium/dense thirds of the bucket list.
      // Per-bucket weights inside each band are equal; a 3-bucket class
      // gets exactly [0.05, 0.15, 0.80]. Indices are stable across runs
      // because the bucket list order is the schema's declared order.
      const B = cls.buckets.values.length;
      const sparseEnd = Math.max(1, Math.floor(B / 3));
      const medEnd = Math.max(sparseEnd + 1, Math.floor((2 * B) / 3));
      const denseCount = B - medEnd;
      const sparseCount = sparseEnd;
      const medCount = medEnd - sparseEnd;
      const wSparse = sparseCount > 0 ? 0.05 / sparseCount : 0;
      const wMed = medCount > 0 ? 0.15 / medCount : 0;
      const wDense = denseCount > 0 ? 0.80 / denseCount : 0;
      const cdf = new Array<number>(B);
      let acc = 0;
      for (let i = 0; i < B; i++) {
        const w = i < sparseEnd ? wSparse : i < medEnd ? wMed : wDense;
        acc += w;
        cdf[i] = acc;
      }
      if (acc > 0) { bucketCdf = cdf; bucketCdfTotal = acc; }
    } else if (useSchemaWeights) {
      const cdf = new Array<number>(cls.buckets.values.length);
      let acc = 0;
      for (let i = 0; i < cls.buckets.values.length; i++) {
        const raw = cls.bucket_weights![cls.buckets.values[i]!];
        const w = typeof raw === "number" && raw > 0 ? raw : 0;
        acc += w;
        cdf[i] = acc;
      }
      if (acc > 0) { bucketCdf = cdf; bucketCdfTotal = acc; }
    }
    // useUniform falls through with bucketCdf undefined → uniform branch in
    // generate() (single rng() tick, preserves rng-isolation invariant).
    void useUniform;
    plan = { buckets: cls.buckets.values, tenorNodes, ops, bucketCdf, bucketCdfTotal };
    plans.set(riskClass, plan);
    return plan;
  }

  return {
    generate(riskClass: string): SensitivityRow {
      const plan = planFor(riskClass);
      const buckets = plan.buckets;
      // Wave 5.47a — weighted bucket pick when the schema declared
      // `bucket_weights`; otherwise the historical uniform pick. Both
      // branches consume exactly one rng() draw so the main-rng sequence
      // is unchanged for the no-weights case (preserves byte-equivalence
      // with earlier fixtures and the rng-isolation test suite).
      let bucket: string;
      if (plan.bucketCdf && plan.bucketCdfTotal) {
        const r = rng() * plan.bucketCdfTotal;
        const cdf = plan.bucketCdf;
        let idx = 0;
        while (idx < cdf.length - 1 && r >= cdf[idx]!) idx++;
        bucket = buckets[idx]!;
      } else {
        bucket = buckets[(rng() * buckets.length) | 0]!;
      }
      // Pre-pick the sensitivity_type for this row so the rv_array/rv_scalar
      // handlers can branch on it (the sens_type op may come AFTER risk_value
      // in the dimension list — we cannot rely on op execution order).
      // Wave 7.0.6.19 — coverage floor: when active, FORCE the lowest-count
      // sens-type for this class until each combo has ≥ coverageFloor draws,
      // then fall through to the uniform pick. Always consume exactly one
      // rng() tick so the rng-isolation canary holds in the no-floor default.
      // Wave 7.0.6.20 — reallocation path: when `plannedRowsByClass` was
      // supplied, consult the pre-computed quota table and pick the sens_type
      // with the largest remaining quota (deterministic; the per-row rng()
      // tick is still consumed but discarded — preserves the rng-isolation
      // invariant for downstream bucket/risk_value draws). This guarantees
      // the per-class row total is EXACTLY the planned count instead of the
      // bias-on-pick path's "force first N per combo" approach that could
      // skew toward Delta-heavy starts.
      const sensR = rng();
      let sensType: string;
      if (coverageFloor > 0 && sensTypes.length > 1) {
        const quotas = quotasByClass?.get(riskClass);
        if (quotas) {
          let idx = 0;
          let best = quotas[0]!;
          for (let s = 1; s < sensTypes.length; s++) {
            if (quotas[s]! > best) { idx = s; best = quotas[s]!; }
          }
          // If every quota is exhausted (caller emitted more rows than
          // planned), fall through to the uniform pick so the row still
          // gets a valid sens_type. Tests assert callers stay within the
          // planned count; this branch is purely defensive.
          if (best <= 0) {
            sensType = sensTypes[(sensR * sensTypes.length) | 0]!;
          } else {
            sensType = sensTypes[idx]!;
            quotas[idx] = quotas[idx]! - 1;
          }
        } else {
          let counts = sensCountsByClass.get(riskClass);
          if (!counts) {
            counts = new Array<number>(sensTypes.length).fill(0);
            sensCountsByClass.set(riskClass, counts);
          }
          let idx = -1;
          for (let s = 0; s < sensTypes.length; s++) {
            if (counts[s]! < coverageFloor) { idx = s; break; }
          }
          if (idx < 0) idx = (sensR * sensTypes.length) | 0;
          sensType = sensTypes[idx]!;
          counts[idx] = counts[idx]! + 1;
        }
      } else {
        sensType = sensTypes[(sensR * sensTypes.length) | 0]!;
      }
      const row: SensitivityRow = {
        risk_class: riskClass,
        bucket,
        _hash_tag: buildHashTag(riskClass, bucket),
        _id: ulid(),
      };
      const ops = plan.ops;
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        switch (op.k) {
          case "risk_class": row[op.name] = riskClass; break;
          case "bucket": row[op.name] = bucket; break;
          case "sens_type": row[op.name] = sensType; break;
          case "tenor_array": row[op.name] = plan.tenorNodes ?? []; break;
          case "tenor_pick": row[op.name] = plan.tenorNodes ? plan.tenorNodes[(rng() * plan.tenorNodes.length) | 0]! : ""; break;
          case "rv_array": {
            if (sensType === "Curvature") {
              // Shape A per docs/demo/curvature-scope.md §3a — per-tenor
              // CVR_k^+ / CVR_k^- pairs. cvr_up ∈ [-5, +10], cvr_down ∈
              // [-10, +5] with mild per-tenor correlation so cross-bucket /
              // cross-tenor math (γ_curv = γ_delta², ψ-gate) actually exercises.
              const up = new Array(op.len);
              const down = new Array(op.len);
              for (let j = 0; j < op.len; j++) {
                const u = rng();
                const v = 0.5 * u + 0.5 * rng();
                up[j] = Math.round((u * 15 - 5) * 1e4) / 1e4;
                down[j] = Math.round((v * 15 - 10) * 1e4) / 1e4;
              }
              row[op.name] = { cvr_up: up, cvr_down: down };
            } else {
              // Wave 5.17a — Delta/Vega array values wrapped as a tenor-keyed
              // object so the bank can FT.SEARCH per-tenor without unpacking.
              // Wave 5.52 — emit K ∈ [5..10] tenors per row (uniform draw),
              // sampled without replacement via a Fisher-Yates partial shuffle
              // on the tenor index list. Emitted keys retain the declared
              // tenor order so the Lua kernels see stable iteration. Same
              // rng() drives K-draw, shuffle, and value draws so a given
              // seed is still reproducible. Fallback (missing tenor metadata)
              // preserves the legacy full-length array shape.
              const nodes = plan.tenorNodes;
              if (nodes && nodes.length === op.len && op.len >= 5) {
                const K = 5 + Math.floor(rng() * 6);
                const k = Math.min(K, op.len);
                const idx = new Array<number>(op.len);
                for (let j = 0; j < op.len; j++) idx[j] = j;
                for (let j = 0; j < k; j++) {
                  const swap = j + Math.floor(rng() * (op.len - j));
                  const tmp = idx[j]!; idx[j] = idx[swap]!; idx[swap] = tmp;
                }
                const picked = new Uint8Array(op.len);
                for (let j = 0; j < k; j++) picked[idx[j]!] = 1;
                const obj: Record<string, number> = {};
                for (let j = 0; j < op.len; j++) {
                  if (!picked[j]) continue;
                  obj[nodes[j]!] = Math.round((rng() * 2 - 1) * 1e6) / 1e6;
                }
                row[op.name] = obj;
              } else {
                const arr = new Array(op.len);
                for (let j = 0; j < op.len; j++) arr[j] = Math.round((rng() * 2 - 1) * 1e6) / 1e6;
                if (nodes && nodes.length === op.len) {
                  const obj: Record<string, number> = {};
                  for (let j = 0; j < op.len; j++) obj[nodes[j]!] = arr[j]!;
                  row[op.name] = obj;
                } else {
                  row[op.name] = arr;
                }
              }
            }
            break;
          }
          case "rv_scalar": {
            if (sensType === "Curvature") {
              // Shape A scalar (Equity / FX): a single CVR^+ / CVR^- per factor.
              const u = rng();
              const v = 0.5 * u + 0.5 * rng();
              const cvr_up = Math.round((u * 15 - 5) * 1e4) / 1e4;
              const cvr_down = Math.round((v * 15 - 10) * 1e4) / 1e4;
              row[op.name] = { cvr_up, cvr_down };
            } else {
              // Wave 5.17a — Equity/FX Delta/Vega scalar wrapped as { spot }
              // so all Delta/Vega risk_value payloads are uniform objects
              // (per-tenor for GIRR, single-key for Equity/FX). Numeric value
              // and rng() consumption are unchanged.
              const v = Math.round((rng() * 2 - 1) * 1e6) / 1e6;
              row[op.name] = { spot: v };
            }
            break;
          }
          case "weight_const": row[op.name] = op.value; break;
          case "weight_by_tenor": row[op.name] = op.values[(rng() * op.values.length) | 0]!; break;
          case "weight_by_bucket": row[op.name] = op.table[bucket] ?? 0; break;
          case "tag": row[op.name] = op.prefix + ((rng() * op.card) | 0); break;
          case "numeric": row[op.name] = Math.round(rng() * 100 * 1e4) / 1e4; break;
          case "array_numeric": {
            const arr = new Array(op.len);
            for (let j = 0; j < op.len; j++) arr[j] = Math.round(rng() * 1e6) / 1e6;
            row[op.name] = arr; break;
          }
        }
      }
      // Wave 5.17a — tenant fields drawn from an isolated aux RNG so the main
      // value-RNG sequence above is unchanged across the reshape. trade_id
      // overwrites any value the generic TAG branch may have set (preserves
      // the original main-rng tick count for classes that listed trade_id in
      // their dimensions). risk_factor is new on every row.
      const tradeIdx = (auxRng() * tradePoolSize) | 0;
      row.trade_id = `T${String(tradeIdx + 1).padStart(4, "0")}`;
      const factorIdx = (auxRng() * factorPoolSize) | 0;
      row.risk_factor = `RF_${riskClass}_${String(factorIdx + 1).padStart(2, "0")}`;
      // Wave 6.38.A — desk taxonomy. Asset-class half is determined by the
      // row's risk_class (RATES/FX/EQUITY/CREDIT/COMMODITY) with a RATES
      // fallback for any class without an explicit affinity; the region half
      // is drawn from the aux RNG so the desk is reproducible across runs
      // for a given seed without perturbing the main value-RNG sequence.
      const assetClass = DESK_ASSET_CLASS_BY_RC[riskClass] ?? "RATES";
      const regionIdx = (auxRng() * DESK_REGIONS.length) | 0;
      row.desk = `${assetClass}_${DESK_REGIONS[regionIdx]!}`;
      return row;
    },
  };
}

/**
 * Wave 7.0.6.20 — build a per-sens_type quota vector whose elements sum
 * EXACTLY to `plannedRows` and whose minimum is `min(floor, plannedRows/n)`.
 *
 * The vector starts as a uniform split (`floor(plannedRows / n)` with the
 * remainder distributed to the lowest-index combos so the first sens_type
 * never has fewer rows than the last — important for the Delta-first
 * verifier gate). Below-floor combos are then raised to the floor by
 * stealing from the largest combo. The effective floor is capped at
 * `floor(plannedRows / n)` so the table is always realisable when the
 * caller asked for fewer rows than `n × floor` (small smoke runs).
 *
 * Exported so the api's `runWithWorkers` and tests can independently verify
 * `sum(quotas) === plannedRows` and `min(quotas) >= min(floor, ⌊rows/n⌋)`.
 */
export function computeCoverageQuotas(plannedRows: number, n: number, floor: number): number[] {
  const quotas = new Array<number>(n);
  if (n <= 0) return quotas;
  if (plannedRows <= 0) { for (let i = 0; i < n; i++) quotas[i] = 0; return quotas; }
  const base = Math.floor(plannedRows / n);
  const remainder = plannedRows - base * n;
  for (let i = 0; i < n; i++) quotas[i] = base + (i < remainder ? 1 : 0);
  const effFloor = Math.min(Math.max(0, Math.floor(floor)), Math.floor(plannedRows / n));
  if (effFloor <= 0) return quotas;
  // Bounded iteration: each pass either resolves one below-floor combo or
  // exits (no steal source available). n iterations is sufficient because
  // the uniform-base case has at most one below-floor combo after the
  // remainder distribution.
  for (let iter = 0; iter < n + 1; iter++) {
    let needIdx = -1;
    for (let i = 0; i < n; i++) {
      if (quotas[i]! < effFloor) { needIdx = i; break; }
    }
    if (needIdx < 0) break;
    let stealIdx = -1;
    let stealMax = effFloor;
    for (let i = 0; i < n; i++) {
      if (i === needIdx) continue;
      if (quotas[i]! > stealMax) { stealIdx = i; stealMax = quotas[i]!; }
    }
    if (stealIdx < 0) break;
    const deficit = effFloor - quotas[needIdx]!;
    const available = quotas[stealIdx]! - effFloor;
    const transfer = Math.min(deficit, available);
    if (transfer <= 0) break;
    quotas[needIdx] = quotas[needIdx]! + transfer;
    quotas[stealIdx] = quotas[stealIdx]! - transfer;
  }
  return quotas;
}
