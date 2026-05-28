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
}

export interface RowGenerator {
  generate(riskClass: string): SensitivityRow;
}

const SENSITIVITY_TYPES = ["Delta", "Vega"];

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
}

export function createRowGenerator(
  schema: Schema,
  opts: RowGeneratorOptions = {}
): RowGenerator {
  const rng = seedrandom(String(opts.seed ?? 0));
  const ulid = monotonicFactory();
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
    plan = { buckets: cls.buckets.values, tenorNodes, ops };
    plans.set(riskClass, plan);
    return plan;
  }

  return {
    generate(riskClass: string): SensitivityRow {
      const plan = planFor(riskClass);
      const buckets = plan.buckets;
      const bucket = buckets[(rng() * buckets.length) | 0]!;
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
          case "sens_type": row[op.name] = SENSITIVITY_TYPES[(rng() * 2) | 0]!; break;
          case "tenor_array": row[op.name] = plan.tenorNodes ?? []; break;
          case "tenor_pick": row[op.name] = plan.tenorNodes ? plan.tenorNodes[(rng() * plan.tenorNodes.length) | 0]! : ""; break;
          case "rv_array": {
            const arr = new Array(op.len);
            for (let j = 0; j < op.len; j++) arr[j] = Math.round((rng() * 2 - 1) * 1e6) / 1e6;
            row[op.name] = arr; break;
          }
          case "rv_scalar": row[op.name] = Math.round((rng() * 2 - 1) * 1e6) / 1e6; break;
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
      return row;
    },
  };
}
