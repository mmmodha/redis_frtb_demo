import { monotonicFactory } from "ulid";
import seedrandom from "seedrandom";
import type { Dimension, Schema, RiskClassConfig } from "@frtb/schema";

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
}

export interface RowGenerator {
  generate(riskClass: string): SensitivityRow;
}

const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega"] as const;
const DEFAULT_TRADE_POOL_SIZE = 200;
const DEFAULT_FACTOR_POOL_SIZE = 16;

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
    let bucketCdf: number[] | undefined;
    let bucketCdfTotal: number | undefined;
    if (cls.bucket_weights) {
      const cdf = new Array<number>(cls.buckets.values.length);
      let acc = 0;
      for (let i = 0; i < cls.buckets.values.length; i++) {
        const raw = cls.bucket_weights[cls.buckets.values[i]!];
        const w = typeof raw === "number" && raw > 0 ? raw : 0;
        acc += w;
        cdf[i] = acc;
      }
      if (acc > 0) {
        bucketCdf = cdf;
        bucketCdfTotal = acc;
      }
    }
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
      const sensType = sensTypes[(rng() * sensTypes.length) | 0]!;
      const row: SensitivityRow = {
        risk_class: riskClass,
        bucket,
        _hash_tag: `${riskClass}:${bucket}`,
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
      return row;
    },
  };
}
