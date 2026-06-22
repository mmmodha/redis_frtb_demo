// scripts/finalise-rollups.mjs — Wave 7.0.3.A
//
// Standalone one-shot CLI that materialises the per-bucket rollup hashes
// from bulk-loaded `sens:*` docs via FT.AGGREGATE against `idx:sens:slim`.
// Mirrors the field shape that the legacy incremental path
// (services/ingest/src/consumer.ts:emitRollupHincrs +
// services/ingest/src/backfill-rollups.ts:accumulateRollup) emits — minus:
//   * `sum_ws_up_sq` / `sum_ws_down_sq` (verifier §3.2: never read by calc),
//   * `processed:*` markers (bulk path has no stream replay).
//
// Key shape change vs legacy: writes `rollup:<rc>:<bkt>:<sens>[:tenor:<t>]`
// with NO `{...}` hash tag. The legacy path tagged on `<rc>:<bkt>` to slot-
// co-locate atomic MULTI with `processed:{<rc>:<bkt>}:<entryId>`; bulk-load
// is one-shot and writes deterministic final values, so MULTI is not needed
// — dropping the tag spreads the rollup family across every shard.
//
// Inputs (env):
//   REDIS_URL    — proxy endpoint (rediss://… for TLS).
//   SCHEMA_FILE  — schema YAML path (default <repo>/config/schema/frtb-default.yaml).
//   INDEX_NAME   — override slim index name (default idx:sens:slim).
//
// Output: one JSON line to stdout on completion; per-(rc, sens) progress on
// stderr. Idempotent: HSET overwrites the same fields on every re-run.

import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema } from "@frtb/schema";
import { IDX_NAME_SLIM } from "@frtb/rqe";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? join(REPO_ROOT, "config/schema/frtb-default.yaml"),
);
const INDEX_NAME = process.env.INDEX_NAME ?? IDX_NAME_SLIM;
const FT_AGGREGATE_TIMEOUT_MS = 30000;
const PER_TENOR_CLASSES = new Set(["GIRR"]);
const SENS_TYPES = ["Delta", "Vega", "Curvature"];
const LEGS_BY_SENS = {
  Delta: ["delta"],
  Vega: ["vega"],
  Curvature: ["cvr_up", "cvr_down"],
};

// Mirror services/api/src/sbm/aggregate-via-index.ts:escapeTag.
const TAG_SPECIALS = /[\s,.<>{}\[\]"':;!@#$%^&*()\-+=~|\/?]/g;
function escapeTag(v) { return v.replace(TAG_SPECIALS, (m) => `\\${m}`); }

// Tag-free rollup key — DISTINCT from shared/calc/src/rollup-keys.ts:rollupKey.
function rollupKeyNoTag(rc, bkt, sens, tenor) {
  const base = `rollup:${rc}:${bkt}:${sens}`;
  return tenor != null ? `${base}:tenor:${tenor}` : base;
}

// Mirrors services/api/src/sbm/aggregate-via-index.ts:resolveLazyMathWeights.
// Vega / Curvature short-circuit to 1.0 (no *_vega_weights / *_curvature_weights
// table in frtb-default.yaml; naive lookup would zero those legs). Delta
// resolves via the schema's <class>_delta_weights table.
function resolveWeights(schema, rc, leg, perTenor) {
  if (leg !== "delta") return { kind: "constant", value: 1.0 };
  const cls = schema.risk_classes[rc];
  const ref = cls?.risk_weights_ref;
  const table = ref ? schema.risk_weights[ref] : undefined;
  if (!table) return { kind: "constant", value: 0 };
  if ("constant" in table) return { kind: "constant", value: table.constant };
  if ("by_tenor" in table) {
    const nodes = cls?.tenor?.nodes;
    if (perTenor && nodes && nodes.length > 0) {
      return { kind: "by_tenor", values: nodes.map((t) => table.by_tenor[t] ?? 0) };
    }
    return { kind: "constant", value: 0 };
  }
  if ("by_bucket" in table) return { kind: "by_bucket", map: table.by_bucket };
  return { kind: "constant", value: 0 };
}

// Probe MODULE LIST for RediSearch version — same approach as
// services/api/src/lib/search-module-version.ts. Returns 0 if unknown.
async function getSearchVer(client) {
  try {
    const reply = await client.call("MODULE", "LIST");
    if (!Array.isArray(reply)) return 0;
    for (const entry of reply) {
      if (!Array.isArray(entry)) continue;
      let name = null, ver = 0;
      for (let i = 0; i + 1 < entry.length; i += 2) {
        const k = entry[i], v = entry[i + 1];
        if (typeof k !== "string") continue;
        const kl = k.toLowerCase();
        if (kl === "name" && typeof v === "string") name = v.toLowerCase();
        else if (kl === "ver") {
          const n = typeof v === "number" ? v : Number(v);
          if (Number.isFinite(n)) ver = Math.trunc(n);
        }
      }
      if (name === "search") return ver;
    }
  } catch { /* tolerant */ }
  return 0;
}

// Per-version null-coercion idiom — `case(exists(@f),@f,0)` on RediSearch
// 8.x; `@f+0` on 2.10.x. Matches nullCoerceApplyExpr in aggregate-via-index.ts.
function nullSafe(field, searchVer) {
  return searchVer >= 80000 ? `case(exists(@${field}),@${field},0)` : `@${field}+0`;
}
function existsAs1(field, searchVer) {
  return searchVer >= 80000 ? `case(exists(@${field}),1,0)` : `(@${field}+0!=0)`;
}

// Build the per-(rc, leg) s_* field list — same iteration as
// shared/rqe/src/index.mjs:buildSlimSchemaFields → `s_<class>_<leg>[_<tenor>]`.
function sFields(rc, leg, perTenor, tenors) {
  const lower = rc.toLowerCase();
  if (perTenor) return tenors.map((t) => ({ field: `s_${lower}_${leg}_${t}`, tenor: t }));
  return [{ field: `s_${lower}_${leg}`, tenor: null }];
}

// Parse FT.AGGREGATE reply: [count, [k,v,k,v,...], [k,v,k,v,...], ...].
function parseAggRows(reply) {
  if (!Array.isArray(reply) || reply.length < 1) return [];
  const out = [];
  for (let i = 1; i < reply.length; i++) {
    const r = reply[i];
    if (!Array.isArray(r)) continue;
    const row = {};
    for (let j = 0; j + 1 < r.length; j += 2) {
      const k = r[j], v = r[j + 1];
      if (typeof k === "string") row[k] = typeof v === "string" ? v : String(v);
    }
    out.push(row);
  }
  return out;
}

function logLine(obj) { process.stderr.write(JSON.stringify(obj) + "\n"); }

// Aggregate one (rc, sens) pair and HSET tag-free rollup keys. Returns
// counters for the JSON summary. Curvature emits sum_ws_up / sum_ws_down
// (no _sq fields per §3.2); Delta/Vega emit sum_ws / sum_ws_sq. Scalar key
// `rollup:<rc>:<bkt>:<sens>` always present; per-tenor `:tenor:<t>` keys
// only when rc is in PER_TENOR_CLASSES.
async function finaliseRcSens(client, schema, rc, sens, searchVer, indexName) {
  const cls = schema.risk_classes[rc];
  if (!cls) return { written: 0, empty: 1, errors: 0 };
  const tenorNodes = cls.tenor?.nodes ?? [];
  const perTenor = PER_TENOR_CLASSES.has(rc) && tenorNodes.length > 0;
  const legs = LEGS_BY_SENS[sens];

  const legSpecs = legs.map((leg) => ({
    leg,
    fields: sFields(rc, leg, perTenor, tenorNodes),
    weights: resolveWeights(schema, rc, leg, perTenor),
  }));

  const loadSeen = new Set();
  const loadFields = [];
  const applyClauses = []; // [expr, alias]
  const reduceSums = [];   // [srcAlias, outAlias]
  const presenceAliases = [];
  const rowWsPartsByLeg = new Map(legs.map((l) => [l, []]));

  for (const { leg, fields, weights } of legSpecs) {
    for (let i = 0; i < fields.length; i++) {
      const { field, tenor } = fields[i];
      if (!loadSeen.has(field)) { loadSeen.add(field); loadFields.push(field); }

      // by_bucket Delta keeps multiplier 1 here — APPLY has no @bucket
      // binding; the per-bucket weight is folded into the merged sums below.
      let mult = 1.0;
      if (weights.kind === "constant") mult = weights.value;
      else if (weights.kind === "by_tenor") mult = weights.values[i] ?? 0;

      const base = nullSafe(field, searchVer);
      const safeAlias = `${field}_safe`;
      applyClauses.push([mult === 1.0 ? base : `(${base}*${mult})`, safeAlias]);

      const sqAlias = `${field}_sq`;
      applyClauses.push([`(@${safeAlias}*@${safeAlias})`, sqAlias]);

      const nAlias = `${field}_n`;
      applyClauses.push([existsAs1(field, searchVer), nAlias]);
      presenceAliases.push(nAlias);

      if (perTenor && tenor != null) {
        reduceSums.push([safeAlias, `__t_${tenor}_${leg}_sum`]);
        if (sens !== "Curvature") reduceSums.push([sqAlias, `__t_${tenor}_${leg}_sumsq`]);
        reduceSums.push([nAlias, `__t_${tenor}_${leg}_count`]);
      }

      rowWsPartsByLeg.get(leg).push(`@${safeAlias}`);
    }
  }

  // Per-leg row-level scalar sums (Σ over tenors → row_ws); row_ws² needed
  // only for Delta/Vega (Curvature drops _sq per §3.2).
  for (const leg of legs) {
    const parts = rowWsPartsByLeg.get(leg);
    const rowWsAlias = `__row_${leg}`;
    applyClauses.push([parts.length === 1 ? parts[0] : `(${parts.join("+")})`, rowWsAlias]);
    reduceSums.push([rowWsAlias, `__scalar_${leg}_sum`]);
    if (sens !== "Curvature") {
      const rowWsSqAlias = `__row_${leg}_sq`;
      applyClauses.push([`(@${rowWsAlias}*@${rowWsAlias})`, rowWsSqAlias]);
      reduceSums.push([rowWsSqAlias, `__scalar_${leg}_sumsq`]);
    }
  }

  // Scalar-key count: rows where ANY s_* field is populated. Mirrors the
  // legacy `typeof weighted_value === "number"` gate after reconstruction.
  const presenceParts = presenceAliases.map((a) => `@${a}`);
  const presenceExpr = presenceParts.length === 1
    ? `(${presenceParts[0]}>0)`
    : `((${presenceParts.join("+")})>0)`;
  applyClauses.push([presenceExpr, "__row_present"]);
  reduceSums.push(["__row_present", "__scalar_count"]);

  const query = `@risk_class:{${escapeTag(rc)}} @sensitivity_type:{${escapeTag(sens)}}`;
  const args = [indexName, query];
  if (loadFields.length > 0) {
    args.push("LOAD", String(loadFields.length), ...loadFields.map((f) => `@${f}`));
  }
  for (const [expr, alias] of applyClauses) args.push("APPLY", expr, "AS", alias);
  args.push("GROUPBY", "1", "@bucket");
  for (const [src, alias] of reduceSums) args.push("REDUCE", "SUM", "1", `@${src}`, "AS", alias);
  args.push("LIMIT", "0", "100000");
  args.push("DIALECT", "2");
  args.push("TIMEOUT", String(FT_AGGREGATE_TIMEOUT_MS));

  let reply;
  try {
    reply = await client.call("FT.AGGREGATE", ...args);
  } catch (err) {
    logLine({ event: "ft_aggregate_failed", rc, sens, err: String(err?.message ?? err) });
    return { written: 0, empty: 0, errors: 1 };
  }
  const rows = parseAggRows(reply);
  if (rows.length === 0) return { written: 0, empty: 1, errors: 0 };

  // by_bucket post-multipliers (Delta only — Vega/Curvature short-circuited
  // to constant 1.0 in resolveWeights).
  const byBucketByLeg = new Map();
  for (const { leg, weights } of legSpecs) {
    if (weights.kind === "by_bucket") byBucketByLeg.set(leg, weights.map);
  }

  const pipe = client.pipeline();
  let written = 0;
  for (const row of rows) {
    const bkt = row.bucket;
    if (!bkt) continue;

    const scalarKey = rollupKeyNoTag(rc, bkt, sens);
    const count = Number(row["__scalar_count"] ?? 0);
    if (sens === "Curvature") {
      const upSum = Number(row["__scalar_cvr_up_sum"] ?? 0);
      const downSum = Number(row["__scalar_cvr_down_sum"] ?? 0);
      pipe.call("HSET", scalarKey,
        "sum_ws_up", String(upSum),
        "sum_ws_down", String(downSum),
        "count", String(count));
    } else {
      const leg = legs[0];
      let sum = Number(row[`__scalar_${leg}_sum`] ?? 0);
      let sumSq = Number(row[`__scalar_${leg}_sumsq`] ?? 0);
      if (byBucketByLeg.has(leg)) {
        const w = byBucketByLeg.get(leg)[bkt] ?? 0;
        sum *= w;
        sumSq *= w * w;
      }
      pipe.call("HSET", scalarKey,
        "sum_ws", String(sum),
        "sum_ws_sq", String(sumSq),
        "count", String(count));
    }
    written++;

    if (!perTenor) continue;
    for (const tenor of tenorNodes) {
      const tKey = rollupKeyNoTag(rc, bkt, sens, tenor);
      if (sens === "Curvature") {
        const tCount = Number(row[`__t_${tenor}_cvr_up_count`] ?? 0);
        if (tCount === 0) continue;
        const upSum = Number(row[`__t_${tenor}_cvr_up_sum`] ?? 0);
        const downSum = Number(row[`__t_${tenor}_cvr_down_sum`] ?? 0);
        pipe.call("HSET", tKey,
          "sum_ws_up", String(upSum),
          "sum_ws_down", String(downSum),
          "count", String(tCount));
      } else {
        const leg = legs[0];
        const tCount = Number(row[`__t_${tenor}_${leg}_count`] ?? 0);
        if (tCount === 0) continue;
        let sum = Number(row[`__t_${tenor}_${leg}_sum`] ?? 0);
        let sumSq = Number(row[`__t_${tenor}_${leg}_sumsq`] ?? 0);
        if (byBucketByLeg.has(leg)) {
          const w = byBucketByLeg.get(leg)[bkt] ?? 0;
          sum *= w;
          sumSq *= w * w;
        }
        pipe.call("HSET", tKey,
          "sum_ws", String(sum),
          "sum_ws_sq", String(sumSq),
          "count", String(tCount));
      }
      written++;
    }
  }
  const results = await pipe.exec();
  let errors = 0;
  for (const r of results ?? []) if (r && r[0]) errors++;
  logLine({ event: "rc_sens_done", rc, sens, buckets: rows.length, written, errors });
  return { written, empty: 0, errors };
}

async function main() {
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`schema file not found: ${SCHEMA_PATH}`);
  }
  const schema = loadSchema(SCHEMA_PATH);
  const client = createRedisClient({
    cluster: false,
    commandTimeout: FT_AGGREGATE_TIMEOUT_MS + 5_000,
  });
  const t0 = Date.now();
  let written = 0, empty = 0, errors = 0;
  try {
    const searchVer = await getSearchVer(client);
    logLine({ event: "start", index: INDEX_NAME, schema: SCHEMA_PATH, searchVer });
    for (const rc of Object.keys(schema.risk_classes)) {
      for (const sens of SENS_TYPES) {
        const r = await finaliseRcSens(client, schema, rc, sens, searchVer, INDEX_NAME);
        written += r.written; empty += r.empty; errors += r.errors;
      }
    }
  } finally {
    await client.quit().catch(() => undefined);
  }
  const elapsed_ms = Date.now() - t0;
  console.log(JSON.stringify({
    event: "finalise_complete",
    rollups_written: written,
    empty_groups: empty,
    errors,
    elapsed_ms,
  }));
  if (errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "fatal", err: String(err?.message ?? err) }));
  process.exit(1);
});
