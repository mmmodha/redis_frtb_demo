#!/usr/bin/env node
// scripts/assert-shard-balance.mjs — Wave 7.0.6.5
//
// 450M pre-flight Gate 4 (and post-run DoD check): asserts that no master
// shard's keys or memory deviates more than ±tolerance from the cluster
// mean. Parses one or two `rladmin info shards` text outputs via the SAME
// parser the api uses (services/api/src/lib/rladmin-parser.mjs, the
// Wave 7.0.4.A module extracted in 7.0.6.5 so plain-node scripts can
// import it without tsx).
//
// Usage:
//   node scripts/assert-shard-balance.mjs --after <path>
//   node scripts/assert-shard-balance.mjs --before <path> --after <path>
//     [--tolerance F=0.05] [--check keys|memory|both=both]
//
// With --before: per-master deltas (after - before) are compared to the
// mean delta. Without: absolute values from --after are compared to the
// cluster mean.
//
// --check keys requires the rladmin snapshot to include a KEYS / OBJECTS /
// NUM_KEYS column — older snapshot formats lack it, in which case the
// script exits 2 with a clear error rather than silently passing.
//
// Exit codes:
//   0  all metrics within tolerance; one-line summary on stdout.
//   1  one or more metrics out of tolerance; per-shard breakdown on stderr.
//   2  usage / input error.

import { readFileSync } from "node:fs";
import { parseRladminShards } from "../services/api/src/lib/rladmin-parser.mjs";

const DEFAULTS = { tolerance: 0.05, check: "both" };
const VALID_CHECKS = new Set(["keys", "memory", "both"]);

export function parseArgs(argv) {
  const args = { ...DEFAULTS, before: null, after: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--before") args.before = next();
    else if (a === "--after") args.after = next();
    else if (a === "--tolerance") args.tolerance = Number(next());
    else if (a === "--check") args.check = next();
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a?.startsWith("--")) throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function helpText() {
  return [
    "Usage: node scripts/assert-shard-balance.mjs --after <path>",
    "       [--before <path>] [--tolerance F=0.05] [--check keys|memory|both]",
    "",
    "Parses `rladmin info shards` text via services/api/src/lib/rladmin-parser.mjs.",
    "Pass --before to compute deltas; omit for absolute-value assertion.",
  ].join("\n");
}

// Extract per-master metric map keyed by shard_id. Returns undefined for the
// metric on rows that lack key_count (older snapshot formats).
function metricsByShard(rows, metric) {
  const out = new Map();
  for (const r of rows) {
    if (r.role !== "master") continue;
    const v = metric === "keys" ? r.key_count : r.memory_used;
    if (v == null) { out.set(r.shard_id, null); continue; }
    out.set(r.shard_id, Number(v));
  }
  return out;
}

// evaluateOne computes per-shard deviation from the mean and returns
// { ok, mean, perShard: [{ shard_id, value, deviation_pct, within }], reason? }.
// reason is set when the snapshot is unusable (no masters, missing column).
export function evaluateOne(metric, afterRows, beforeRows, tolerance) {
  const after = metricsByShard(afterRows, metric);
  if (after.size === 0) {
    return { ok: false, reason: `no master shards in --after snapshot`, perShard: [], mean: 0 };
  }
  const missing = [...after.entries()].filter(([, v]) => v == null).map(([id]) => id);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `--check ${metric} requires KEYS/OBJECTS column in rladmin snapshot; missing for ${missing.length}/${after.size} shards`,
      perShard: [], mean: 0,
    };
  }

  let values;
  if (beforeRows) {
    const before = metricsByShard(beforeRows, metric);
    const beforeMissing = [...after.keys()].filter((id) => before.get(id) == null);
    if (beforeMissing.length > 0) {
      return {
        ok: false,
        reason: `--check ${metric} requires KEYS/OBJECTS column in --before snapshot; missing for ${beforeMissing.length} shards`,
        perShard: [], mean: 0,
      };
    }
    values = [...after.entries()].map(([id, a]) => ({ shard_id: id, value: a - before.get(id) }));
  } else {
    values = [...after.entries()].map(([id, v]) => ({ shard_id: id, value: v }));
  }

  const mean = values.reduce((s, v) => s + v.value, 0) / values.length;
  // Guard against degenerate zero-mean (e.g. before==after delta=0); when the
  // mean is 0 the only consistent verdict is "all shards must be 0 too".
  const perShard = values.map((v) => {
    const deviation_pct = mean === 0 ? (v.value === 0 ? 0 : Infinity) : (v.value - mean) / mean;
    return { ...v, deviation_pct, within: Math.abs(deviation_pct) <= tolerance };
  });
  const ok = perShard.every((s) => s.within);
  return { ok, mean, perShard };
}

export function evaluateBalance({ afterRows, beforeRows, tolerance, check }) {
  const results = {};
  const metrics = check === "both" ? ["keys", "memory"] : [check];
  for (const m of metrics) results[m] = evaluateOne(m, afterRows, beforeRows, tolerance);
  const ok = Object.values(results).every((r) => r.ok);
  return { ok, tolerance, mode: beforeRows ? "delta" : "absolute", metrics: results };
}

function fmtRow(s) {
  const pct = Number.isFinite(s.deviation_pct) ? `${(s.deviation_pct * 100).toFixed(2)}%` : "∞";
  return `  ${s.shard_id.padEnd(10)} value=${String(s.value).padStart(14)}  dev=${pct.padStart(8)}  ${s.within ? "OK" : "OUT"}`;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`ERROR: ${e.message}\n${helpText()}`); process.exit(2); }
  if (args.help) { console.log(helpText()); process.exit(0); }
  if (!args.after) { console.error(`ERROR: --after <path> is required\n${helpText()}`); process.exit(2); }
  if (!VALID_CHECKS.has(args.check)) { console.error(`ERROR: --check must be one of keys|memory|both`); process.exit(2); }
  if (!Number.isFinite(args.tolerance) || args.tolerance < 0) { console.error(`ERROR: --tolerance must be >= 0`); process.exit(2); }

  let afterRows, beforeRows = null;
  try { afterRows = parseRladminShards(readFileSync(args.after, "utf8")); }
  catch (e) { console.error(`ERROR: reading --after ${args.after}: ${e.message}`); process.exit(2); }
  if (args.before) {
    try { beforeRows = parseRladminShards(readFileSync(args.before, "utf8")); }
    catch (e) { console.error(`ERROR: reading --before ${args.before}: ${e.message}`); process.exit(2); }
  }

  const verdict = evaluateBalance({ afterRows, beforeRows, tolerance: args.tolerance, check: args.check });

  if (verdict.ok) {
    const summary = Object.entries(verdict.metrics)
      .map(([m, r]) => `${m}: mean=${r.mean.toFixed(0)} shards=${r.perShard.length}`).join(" · ");
    console.log(`OK · tolerance=${args.tolerance} · mode=${verdict.mode} · ${summary}`);
    process.exit(0);
  }
  console.error(`FAIL · tolerance=${args.tolerance} · mode=${verdict.mode}`);
  for (const [m, r] of Object.entries(verdict.metrics)) {
    if (r.reason) { console.error(`  ${m}: ${r.reason}`); continue; }
    console.error(`  ${m}: mean=${r.mean.toFixed(0)} ${r.ok ? "OK" : "OUT"}`);
    for (const s of r.perShard) console.error(fmtRow(s));
  }
  process.exit(1);
}

const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
    return import.meta.url === argv1;
  } catch { return false; }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: "fatal", err: String(err?.message ?? err) }));
    process.exit(1);
  });
}
