// Wave 5.15 — runs inside the api container. Connects to REDIS_URL,
// discovers cluster masters, queries INFO memory against each shard
// directly. Captures the headroom evidence required by step 2.7.
// Output: a single JSON object to stdout, keyed by host:port.
import IORedis from "ioredis";

const FIELDS = [
  "used_memory_human",
  "used_memory_peak_human",
  "maxmemory",
  "maxmemory_human",
  "maxmemory_policy",
  "mem_fragmentation_ratio",
];

function parseInfo(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const url = process.env.REDIS_URL;
if (!url) {
  console.error(JSON.stringify({ error: "REDIS_URL unset inside container" }));
  process.exit(2);
}

const parsed = new URL(url);
const password = decodeURIComponent(parsed.password || "");
const username = decodeURIComponent(parsed.username || "") || undefined;
const tls = parsed.protocol === "rediss:" ? {} : undefined;
const host = parsed.hostname;
const port = Number(parsed.port || 6379);

const seed = new IORedis.Cluster([{ host, port }], {
  redisOptions: { password, username, tls },
  scaleReads: "all",
  enableReadyCheck: true,
  lazyConnect: true,
});

try {
  await seed.connect();
  const nodes = seed.nodes("master");
  const result = {};
  for (const n of nodes) {
    const addr = `${n.options.host}:${n.options.port}`;
    try {
      const raw = await n.info("memory");
      const info = parseInfo(raw);
      const slim = {};
      for (const f of FIELDS) slim[f] = info[f] ?? null;
      result[addr] = slim;
    } catch (e) {
      result[addr] = { error: String(e && e.message || e) };
    }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(JSON.stringify({ error: String(e && e.message || e) }));
  process.exit(1);
} finally {
  try { await seed.quit(); } catch { /* ignore */ }
}
