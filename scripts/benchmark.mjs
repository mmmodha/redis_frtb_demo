// scripts/benchmark.mjs — Wave 6.33 Phase 0 smoke benchmark.
//
// Probes the active cloud Redis cluster, ingests a small bench slice (default
// 100k rows), samples per-shard key distribution, optionally times the api's
// /calc/sbm/total, cleans up its own keys, and writes a sanitised recording.
//
// Inputs (env, NEVER inlined into argv or stdout):
//   REDIS_URL        — full redis(s) URL with credentials. Required.
//   REDIS_TLS        — "1"/"true" forces TLS even when scheme is redis://.
//   REDIS_USERNAME   — optional ACL username override.
//   REDIS_PASSWORD   — optional password override (else parsed from URL).
//   API_BASE         — defaults to http://localhost:8080. Used for /calc/sbm/total.
//
// Flags:
//   --rows N         — number of bench rows to HSET (default 100000)
//   --runId ID       — required string used in the bench: prefix
//   --slots K        — slots to sample for distribution (default 500)
//   --record-dir DIR — baseline recording dir (default docs/recordings/wave-6.33-phase-0)
//   --no-calc        — skip the /calc/sbm/total timing leg
//
// Output contract: stdout JSON summary only. NEVER echoes host, port, password,
// URL, or any auth material. All recording artefacts are sanitised.

import { Redis } from "ioredis";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const out = { rows: 100000, runId: null, slots: 500, recordDir: "docs/recordings/wave-6.33-phase-0", calc: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rows") out.rows = Number(argv[++i]);
    else if (a === "--runId") out.runId = argv[++i];
    else if (a === "--slots") out.slots = Number(argv[++i]);
    else if (a === "--record-dir") out.recordDir = argv[++i];
    else if (a === "--no-calc") out.calc = false;
  }
  return out;
}

function fail(msg) { console.error(JSON.stringify({ event: "fatal", err: msg })); process.exit(1); }

const args = parseArgs(process.argv.slice(2));
if (!args.runId) fail("--runId is required");
if (!Number.isFinite(args.rows) || args.rows <= 0) fail("--rows must be a positive integer");
if (!/^[a-zA-Z0-9._-]+$/.test(args.runId)) fail("--runId must match [a-zA-Z0-9._-]+");

const url = process.env.REDIS_URL;
if (!url) fail("REDIS_URL not set — credentials must be in .env.local / .run/env on the operator's machine");

let u;
try { u = new URL(url); } catch { fail("REDIS_URL is not a valid URL"); }
const tlsOpt = (u.protocol === "rediss:" || /^(1|true|yes)$/i.test(process.env.REDIS_TLS ?? "")) ? { tls: {} } : {};
const password = process.env.REDIS_PASSWORD || (u.password ? decodeURIComponent(u.password) : undefined);
const username = process.env.REDIS_USERNAME || (u.username ? decodeURIComponent(u.username) : undefined);

const redis = new Redis({
  host: u.hostname, port: Number(u.port) || 6379,
  password, username, ...tlsOpt,
  lazyConnect: true, maxRetriesPerRequest: 3, enableOfflineQueue: true,
});
await redis.connect();

const prefix = `bench:${args.runId}:`;
const baselineDbsize = await redis.dbsize();
const t0 = Date.now();

async function probeShards() {
  let shards = null, nodes = null;
  try { shards = await redis.call("CLUSTER", "SHARDS"); } catch { /* fallback */ }
  try { nodes = await redis.call("CLUSTER", "NODES"); } catch { /* may not be supported */ }
  const slotRanges = []; // [{ shardIdx, start, end }]
  let shardCount = 0;
  if (Array.isArray(shards)) {
    for (let i = 0; i < shards.length; i++) {
      const entry = shards[i];
      if (!Array.isArray(entry)) continue;
      const obj = {};
      for (let j = 0; j + 1 < entry.length; j += 2) obj[String(entry[j])] = entry[j + 1];
      const slots = obj.slots;
      if (Array.isArray(slots)) for (let k = 0; k + 1 < slots.length; k += 2) slotRanges.push({ shardIdx: i, start: Number(slots[k]), end: Number(slots[k + 1]) });
    }
    shardCount = shards.length;
  } else if (typeof nodes === "string") {
    const lines = nodes.split("\n").filter((l) => l.includes("master"));
    shardCount = lines.length;
    lines.forEach((line, i) => {
      const parts = line.split(" ");
      for (let j = 8; j < parts.length; j++) {
        const m = parts[j].match(/^(\d+)-(\d+)$/);
        if (m) slotRanges.push({ shardIdx: i, start: Number(m[1]), end: Number(m[2]) });
      }
    });
  }
  return { shardCount, slotRanges };
}

const { shardCount, slotRanges } = await probeShards();

async function recordBaseline() {
  if (!existsSync(args.recordDir)) mkdirSync(args.recordDir, { recursive: true });
  const modules = (await redis.call("MODULE", "LIST").catch(() => [])) || [];
  const moduleNames = Array.isArray(modules) ? modules.map((m) => { const o = {}; if (Array.isArray(m)) for (let j = 0; j + 1 < m.length; j += 2) o[String(m[j])] = m[j + 1]; return { name: o.name, ver: o.ver }; }) : [];
  writeFileSync(join(args.recordDir, "topology.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    shard_count: shardCount,
    slot_range_count: slotRanges.length,
    modules: moduleNames,
    notes: "host/port/auth intentionally omitted per Wave 6.33 P0 guard-rails",
  }, null, 2));
  const memInfo = await redis.info("memory");
  const mem = {};
  for (const m of memInfo.matchAll(/^(used_memory[^:]*|maxmemory[^:]*|mem_fragmentation_ratio):([^\r\n]+)/gm)) mem[m[1]] = m[2].trim();
  writeFileSync(join(args.recordDir, "memory-empty.json"), JSON.stringify({ generated_at: new Date().toISOString(), info_memory: mem }, null, 2));
  let ftList = []; try { ftList = (await redis.call("FT._LIST")) || []; } catch { ftList = []; }
  writeFileSync(join(args.recordDir, "ft-list.json"), JSON.stringify({ generated_at: new Date().toISOString(), indices: Array.isArray(ftList) ? ftList.map(String) : [] }, null, 2));
  return { shardCount, modules: moduleNames.length, ft_list_count: Array.isArray(ftList) ? ftList.length : 0 };
}

const baseline = await recordBaseline();

async function ingestRows() {
  const batchSize = 1000;
  let written = 0;
  for (let i = 0; i < args.rows; i += batchSize) {
    const p = redis.pipeline();
    const end = Math.min(i + batchSize, args.rows);
    for (let k = i; k < end; k++) {
      const key = `${prefix}${k}`;
      p.hset(key, { i: String(k), v: "x".repeat(64), runId: args.runId });
    }
    await p.exec();
    written = end;
  }
  return written;
}

const tIngest0 = Date.now();
const written = await ingestRows();
const ingestMs = Date.now() - tIngest0;

let perShard = new Array(Math.max(shardCount, 1)).fill(0);
let sampledSlots = 0;
if (slotRanges.length > 0) {
  const step = Math.max(1, Math.floor(16384 / Math.max(1, args.slots)));
  for (let slot = 0; slot < 16384; slot += step) {
    let count = 0;
    try { count = Number(await redis.call("CLUSTER", "COUNTKEYSINSLOT", slot)); } catch { continue; }
    const r = slotRanges.find((x) => slot >= x.start && slot <= x.end);
    if (r) perShard[r.shardIdx] = (perShard[r.shardIdx] || 0) + count;
    sampledSlots++;
  }
}

let calcResult = { skipped: !args.calc };
if (args.calc) {
  const apiBase = process.env.API_BASE || "http://localhost:8080";
  const tCalc0 = Date.now();
  try {
    const res = await fetch(`${apiBase}/calc/sbm/total`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    calcResult = { status: res.status, ms: Date.now() - tCalc0 };
  } catch (e) { calcResult = { error: String(e && e.message || e), ms: Date.now() - tCalc0 }; }
}

async function cleanup() {
  let stream = redis.scanStream({ match: `${prefix}*`, count: 1000 });
  let deleted = 0;
  for await (const keys of stream) {
    if (keys.length === 0) continue;
    const p = redis.pipeline();
    for (const k of keys) p.unlink(k);
    await p.exec();
    deleted += keys.length;
  }
  return deleted;
}

const tCleanup0 = Date.now();
const deleted = await cleanup();
const cleanupMs = Date.now() - tCleanup0;
const finalDbsize = await redis.dbsize();
const drift = finalDbsize - baselineDbsize;

const summary = {
  generated_at: new Date().toISOString(),
  runId: args.runId,
  rows_requested: args.rows,
  rows_written: written,
  ingest_ms: ingestMs,
  shard_count: shardCount,
  sampled_slots: sampledSlots,
  per_shard_key_counts: perShard,
  calc_sbm_total: calcResult,
  cleanup: { keys_deleted: deleted, ms: cleanupMs },
  dbsize: { baseline: baselineDbsize, final: finalDbsize, drift },
  total_ms: Date.now() - t0,
  baseline_recording: { dir: args.recordDir, ...baseline },
};

const recordPath = join(args.recordDir, "smoke-output.txt");
if (!existsSync(args.recordDir)) mkdirSync(args.recordDir, { recursive: true });
writeFileSync(recordPath, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));

if (Math.abs(drift) > 10) {
  console.error(JSON.stringify({ event: "dbsize_drift_warning", drift, baseline: baselineDbsize, final: finalDbsize }));
  await redis.quit().catch(() => undefined);
  process.exit(2);
}
await redis.quit().catch(() => undefined);
