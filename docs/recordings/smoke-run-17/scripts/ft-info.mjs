// Wave 5.17d — topology-aware FT.INFO probe for the smoke-run-17 procedure.
// Mirrors used-memory.mjs's REDIS_CLUSTER auto-detection so the same script
// runs against either cluster or standalone Redis Cloud DBs without rewrite.
import IORedis from "ioredis";

const u = new URL(process.env.REDIS_URL);
const tlsEnv = String(process.env.REDIS_TLS || "").toLowerCase();
const useTls = u.protocol === "rediss:" ||
  ["1", "true", "yes", "on"].includes(tlsEnv);
const password = decodeURIComponent(u.password || "") || undefined;
const username = decodeURIComponent(u.username || "") || undefined;
const host = u.hostname;
const port = Number(u.port);
const clusterEnv = String(process.env.REDIS_CLUSTER || "").toLowerCase();
const clusterMode = ["1", "true", "yes", "on"].includes(clusterEnv);

let client;
if (clusterMode) {
  client = new IORedis.Cluster(
    [{ host, port }],
    {
      redisOptions: { password, username, ...(useTls ? { tls: {} } : {}) },
      scaleReads: "all",
      lazyConnect: true,
      slotsRefreshTimeout: 5_000,
    },
  );
  client.on("error", () => {});
  await client.connect();
} else {
  client = new IORedis({
    host, port, password, username,
    ...(useTls ? { tls: {} } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 8_000,
  });
  client.on("error", () => {});
  await client.connect();
}

const out = { mode: clusterMode ? "cluster" : "standalone", per_master: {} };
const nodes = clusterMode ? client.nodes("master") : [client];
for (const n of nodes) {
  const addr = clusterMode
    ? `${n.options.host}:${n.options.port}`
    : `${host}:${port}`;
  try {
    const raw = await n.call("FT.INFO", "idx:sens");
    const obj = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) obj[raw[i]] = raw[i + 1];
    }
    out.per_master[addr] = {
      num_docs: obj.num_docs ?? null,
      hash_indexing_failures: obj.hash_indexing_failures ?? null,
      indexing: obj.indexing ?? null,
      total_indexing_time: obj.total_indexing_time ?? null,
    };
  } catch (e) {
    out.per_master[addr] = { error: String((e && e.message) || e) };
  }
}
try {
  out.xlen_stream = await client.call("XLEN", "sensitivities:in");
} catch (e) { out.xlen_stream = String((e && e.message) || e); }
console.log(JSON.stringify(out, null, 2));
await client.quit();
