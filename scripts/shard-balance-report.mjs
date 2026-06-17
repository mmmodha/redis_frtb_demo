// scripts/shard-balance-report.mjs — Wave 6.19 shard-balance diagnostic.
//
// Read-only health check answering "are the shards balanced at this scale?"
// for a Redis Cluster (or Redis Enterprise via proxy) target. Reports:
//   * per-shard: master addr, slot ranges, sens_key_count (from FT.AGGREGATE
//                COUNT on idx:sens), used_memory_human, used_memory_bytes
//   * per-tag:   <risk_class>:<bucket>, row count, slot, owning shard,
//                % of total
//   * top 10 hottest tags (sorted by row count)
//   * skew ratios (max/min rows, max/min memory)
//   * verdict:   `balanced (skew < 1.5x)` | `mild skew (1.5-3x)` |
//                `severe skew (>3x)` | `single shard target — skew N/A`
//
// Inputs (env):
//   REDIS_URL        — connection string (cluster or proxy). Secrets policy:
//                      never echo URL, password, or url-decoded credentials.
//   REDIS_CLUSTER    — "true" to force cluster-mode client (default: auto-
//                      detect from URL scheme + CLUSTER INFO probe).
//   SCHEMA_FILE      — path to the schema YAML (default:
//                      config/schema/frtb-default.yaml). Used to seed the
//                      tag-space cartesian; falls back to runtime SCAN if
//                      unreadable.
//   FT_INDEX         — RediSearch index name (default: "idx:sens").
//
// Output:
//   stdout — single JSON object.
//   stderr — human-readable summary table.
//   logfile — `.run/logs/shard-balance-<ISO>.json` (created on completion).
//
// Read-only; no DEL, no FLUSH, no DEBUG. Total runtime budget: < 60s on
// bigcluster at 100M.

import { Redis, Cluster } from "ioredis";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const url = process.env.REDIS_URL;
if (!url) { console.error(JSON.stringify({ event: "missing_redis_url" })); process.exit(1); }
const u = new URL(url);
const tlsOpt = u.protocol === "rediss:" ? { tls: {} } : {};
const password = decodeURIComponent(u.password || "") || undefined;
const username = decodeURIComponent(u.username || "") || undefined;
const indexName = process.env.FT_INDEX ?? "idx:sens";

const forceCluster = String(process.env.REDIS_CLUSTER ?? "").toLowerCase() === "true";
const seed = forceCluster
  ? new Cluster([{ host: u.hostname, port: Number(u.port) }], {
      redisOptions: { password, username, ...tlsOpt },
      scaleReads: "master",
      lazyConnect: true,
    })
  : new Redis({ host: u.hostname, port: Number(u.port), password, username, ...tlsOpt, lazyConnect: true });
await seed.connect();

// Tag-space discovery: prefer the schema cartesian for known tags + slot
// ownership; fall back to runtime aggregation when the schema isn't readable.
function tagsFromSchema() {
  const path = process.env.SCHEMA_FILE
    ?? resolve(process.cwd(), "config/schema/frtb-default.yaml");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const out = [];
  // Lightweight YAML walk: look for `risk_classes:` block and within each
  // `<RC>:` capture `values: [...]` from its `buckets:` subblock. Avoids
  // pulling a YAML dep — the schema's structure is stable.
  const rcMatch = raw.match(/^risk_classes:\s*$([\s\S]+?)(?=^[a-z_]|\Z)/m);
  if (!rcMatch) return null;
  const block = rcMatch[1];
  const rcRe = /^  ([A-Z_]+):\s*$/gm;
  let m;
  while ((m = rcRe.exec(block))) {
    const rc = m[1];
    const after = block.slice(m.index);
    const bm = after.match(/buckets:[\s\S]*?values:\s*\[([^\]]+)\]/);
    if (!bm) continue;
    const values = bm[1].split(",").map((v) => v.trim().replace(/^["']|["']$/g, ""));
    for (const v of values) out.push(`${rc}:${v}`);
  }
  return out.length > 0 ? out : null;
}

// CLUSTER SLOTS → master → slot ranges. Degrade to a single-shard view
// when the proxy refuses (Redis Enterprise often does) — the report still
// works against INFO + tag aggregation.
let slotsByMaster = {};
let multiShard = false;
try {
  const slots = await seed.call("CLUSTER", "SLOTS");
  if (Array.isArray(slots)) {
    for (const range of slots) {
      if (!Array.isArray(range) || range.length < 3) continue;
      const [start, end, master] = range;
      if (!Array.isArray(master)) continue;
      const addr = `${master[0]}:${master[1]}`;
      (slotsByMaster[addr] ??= []).push([start, end]);
    }
  }
  multiShard = Object.keys(slotsByMaster).length > 1;
} catch { /* proxy without CLUSTER SLOTS — fine */ }

// Per-shard memory: INFO memory per master (or single host).
const perShard = {};
const masters = forceCluster && seed.nodes ? seed.nodes("master") : [seed];
for (const node of masters) {
  const addr = (node.options && node.options.host)
    ? `${node.options.host}:${node.options.port}`
    : `${u.hostname}:${u.port}`;
  let mem = "?", memBytes = 0;
  try {
    const info = await node.info("memory");
    const h = info.match(/used_memory_human:([^\r\n]+)/);
    const b = info.match(/used_memory:(\d+)/);
    if (h) mem = h[1].trim();
    if (b) memBytes = Number(b[1]);
  } catch { /* skip */ }
  perShard[addr] = { used_memory_human: mem, used_memory_bytes: memBytes, sens_key_count: 0, slot_ranges: slotsByMaster[addr] ?? [] };
}

// Per-tag row counts via FT.AGGREGATE GROUPBY @risk_class @bucket.
let perTag = [];
try {
  const reply = await seed.call(
    "FT.AGGREGATE", indexName, "*",
    "GROUPBY", "2", "@risk_class", "@bucket",
    "REDUCE", "COUNT", "0", "AS", "n",
    "SORTBY", "2", "@n", "DESC",
    "LIMIT", "0", "200",
    "DIALECT", "2",
  );
  if (Array.isArray(reply)) {
    for (let i = 1; i < reply.length; i++) {
      const row = reply[i];
      if (!Array.isArray(row)) continue;
      const m = {};
      for (let j = 0; j + 1 < row.length; j += 2) m[String(row[j]).replace(/^@/, "")] = String(row[j + 1]);
      if (m.risk_class && m.bucket && m.n) perTag.push({ tag: `${m.risk_class}:${m.bucket}`, count: Number(m.n) });
    }
  }
} catch (e) { console.error(JSON.stringify({ event: "ft_aggregate_failed", err: String(e && e.message || e) })); }

// Augment per-tag with slot + owning shard, accumulate per-shard counts.
const schemaTags = tagsFromSchema() ?? [];
const allTags = new Set([...perTag.map((p) => p.tag), ...schemaTags]);
const tagDetails = [];
const total = perTag.reduce((s, t) => s + t.count, 0);
for (const tag of allTags) {
  const probe = `sens:{${tag}}:_route`;
  let slot = null, owner = null;
  try { slot = Number(await seed.call("CLUSTER", "KEYSLOT", probe)); } catch { /* proxy may refuse */ }
  if (slot != null) {
    for (const [addr, ranges] of Object.entries(slotsByMaster)) {
      if (ranges.some(([s, e]) => slot >= s && slot <= e)) { owner = addr; break; }
    }
  }
  const found = perTag.find((p) => p.tag === tag);
  const count = found ? found.count : 0;
  const pct = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
  tagDetails.push({ tag, count, slot, owner, pct });
  if (owner) perShard[owner].sens_key_count = (perShard[owner].sens_key_count || 0) + count;
}

// Skew computation + verdict.
const shardRows = Object.values(perShard).map((s) => s.sens_key_count).filter((n) => n > 0);
const shardMem = Object.values(perShard).map((s) => s.used_memory_bytes).filter((n) => n > 0);
const skewRows = shardRows.length > 1 ? Math.max(...shardRows) / Math.max(1, Math.min(...shardRows)) : null;
const skewMem = shardMem.length > 1 ? Math.max(...shardMem) / Math.max(1, Math.min(...shardMem)) : null;
let verdict;
if (!multiShard || shardRows.length <= 1) verdict = "single shard target — skew N/A";
else if (skewRows < 1.5) verdict = "balanced (skew < 1.5x)";
else if (skewRows < 3) verdict = "mild skew (1.5-3x)";
else verdict = "severe skew (>3x)";

const top10 = [...tagDetails].sort((a, b) => b.count - a.count).slice(0, 10);
const out = {
  generated_at: new Date().toISOString(),
  index: indexName,
  multi_shard: multiShard,
  shard_count: Object.keys(perShard).length,
  per_shard: perShard,
  per_tag: tagDetails,
  top_10_hottest_tags: top10,
  skew: { row_count: skewRows, memory_bytes: skewMem },
  verdict,
};

console.log(JSON.stringify(out, null, 2));

console.error("\n=== shard-balance summary ===");
console.error(`index           : ${indexName}`);
console.error(`shard count     : ${Object.keys(perShard).length}${multiShard ? "" : " (single-shard or proxy)"}`);
for (const [addr, s] of Object.entries(perShard)) {
  console.error(`  ${addr.padEnd(28)} rows=${String(s.sens_key_count).padStart(10)} mem=${s.used_memory_human}`);
}
console.error(`skew_rows       : ${skewRows ?? "n/a"}`);
console.error(`skew_memory     : ${skewMem ?? "n/a"}`);
console.error(`verdict         : ${verdict}`);
console.error(`top-10 hot tags :`);
for (const t of top10) console.error(`  ${t.tag.padEnd(18)} ${String(t.count).padStart(10)} (${t.pct}%) shard=${t.owner ?? "?"}`);

const logDir = ".run/logs";
try {
  mkdirSync(logDir, { recursive: true });
  const fn = join(logDir, `shard-balance-${out.generated_at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(fn, JSON.stringify(out, null, 2));
  console.error(`logfile         : ${fn}`);
} catch (e) { console.error(JSON.stringify({ event: "logfile_write_failed", err: String(e && e.message || e) })); }

await (forceCluster ? seed.quit().catch(() => undefined) : seed.quit().catch(() => undefined));
