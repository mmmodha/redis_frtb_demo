// scripts/finalise-seen-sets.mjs — Wave 7.0.3.B
//
// Standalone one-shot CLI that materialises the discovery seen-sets from
// bulk-loaded `sens:*` docs via a single FT.AGGREGATE GROUPBY against
// `idx:sens:slim`. Mirrors the values that the legacy incremental path
// (services/ingest/src/consumer.ts) emits — minus the legacy hash tags.
//
// Key shape change vs scripts/materialize-seen-sets.mjs (legacy SCAN-based):
//   * `seen:risk_class`                — unchanged (already tag-free).
//   * `seen:bucket:<rc>`               — was `seen:bucket:{<rc>}`.
//   * `seen:sens_type:<rc>:<bucket>`   — was `seen:sens_type:{<rc>:<bkt>}`.
// The legacy path tagged on `<rc>` / `<rc>:<bkt>` to slot-co-locate atomic
// MULTI with `processed:{<rc>:<bkt>}:<entryId>` markers for at-least-once
// stream replay. The bulk path writes deterministic final values once, so
// MULTI is not needed — dropping the tags spreads the seen-set family
// across every shard instead of pinning each (rc, bkt) onto one slot.
//
// Inputs (env):
//   REDIS_URL    — proxy endpoint (rediss://… for TLS).
//   INDEX_NAME   — override slim index name (default idx:sens:slim).
//
// Output: one JSON line to stdout on completion; per-step progress on
// stderr. Idempotent: SADD on an already-populated set is a no-op.

import { createRedisClient } from "@frtb/redis-client";
import { IDX_NAME_SLIM } from "@frtb/rqe";

const INDEX_NAME = process.env.INDEX_NAME ?? IDX_NAME_SLIM;
const FT_AGGREGATE_TIMEOUT_MS = 30000;
const AGG_LIMIT = 100000;

function logLine(obj) { process.stderr.write(JSON.stringify(obj) + "\n"); }

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

async function main() {
  const client = createRedisClient({
    cluster: false,
    commandTimeout: FT_AGGREGATE_TIMEOUT_MS + 5_000,
  });
  const t0 = Date.now();
  let triples = 0, riskClasses = 0, buckets = 0, sensTypes = 0;
  let errors = 0;
  try {
    logLine({ event: "start", index: INDEX_NAME });
    const args = [
      INDEX_NAME, "*",
      "GROUPBY", "3", "@risk_class", "@bucket", "@sensitivity_type",
      "REDUCE", "COUNT", "0", "AS", "n",
      "LIMIT", "0", String(AGG_LIMIT),
      "DIALECT", "2",
      "TIMEOUT", String(FT_AGGREGATE_TIMEOUT_MS),
    ];
    let reply;
    try {
      reply = await client.call("FT.AGGREGATE", ...args);
    } catch (err) {
      logLine({ event: "ft_aggregate_failed", err: String(err?.message ?? err) });
      throw err;
    }
    const rows = parseAggRows(reply);
    triples = rows.length;
    logLine({ event: "aggregate_done", triples });
    if (triples >= AGG_LIMIT) {
      logLine({ event: "warn_agg_limit_hit", limit: AGG_LIMIT });
    }

    // Dedupe in TS so each tag-free key takes ONE SADD with N members. With
    // ~7 risk classes × ~25 buckets × ~3 sens types the working set is
    // small enough to fit comfortably in one pipeline batch.
    const rcSet = new Set();
    const bucketByRc = new Map();           // rc → Set<bucket>
    const sensByRcBkt = new Map();          // `${rc}\u0000${bkt}` → Set<sens>
    for (const row of rows) {
      const rc = row.risk_class;
      const bkt = row.bucket;
      const sens = row.sensitivity_type;
      if (!rc || !bkt || !sens) continue;
      rcSet.add(rc);
      let b = bucketByRc.get(rc);
      if (!b) { b = new Set(); bucketByRc.set(rc, b); }
      b.add(bkt);
      const k = `${rc}\u0000${bkt}`;
      let s = sensByRcBkt.get(k);
      if (!s) { s = new Set(); sensByRcBkt.set(k, s); }
      s.add(sens);
    }

    const pipe = client.pipeline();
    if (rcSet.size > 0) pipe.call("SADD", "seen:risk_class", ...rcSet);
    riskClasses = rcSet.size;
    for (const [rc, bkts] of bucketByRc.entries()) {
      if (bkts.size === 0) continue;
      pipe.call("SADD", `seen:bucket:${rc}`, ...bkts);
      buckets += bkts.size;
    }
    for (const [k, types] of sensByRcBkt.entries()) {
      if (types.size === 0) continue;
      const sep = k.indexOf("\u0000");
      const rc = k.slice(0, sep);
      const bkt = k.slice(sep + 1);
      pipe.call("SADD", `seen:sens_type:${rc}:${bkt}`, ...types);
      sensTypes += types.size;
    }
    const results = await pipe.exec();
    for (const r of results ?? []) if (r && r[0]) errors++;
    logLine({ event: "sadd_done", riskClasses, buckets, sensTypes, errors });
  } finally {
    await client.quit().catch(() => undefined);
  }
  const elapsed_ms = Date.now() - t0;
  console.log(JSON.stringify({
    event: "finalise_seen_complete",
    triples,
    risk_classes: riskClasses,
    buckets,
    sens_types: sensTypes,
    errors,
    elapsed_ms,
  }));
  if (errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "fatal", err: String(err?.message ?? err) }));
  process.exit(1);
});
