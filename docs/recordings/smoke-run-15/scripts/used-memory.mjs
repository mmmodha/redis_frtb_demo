// Wave 5.15s — minimal host-side `used_memory` probe.
// Connects to REDIS_URL (standalone or cluster, auto-detected from env),
// runs INFO memory, prints { used_memory_bytes, used_memory_human } as JSON.
// No write side-effects, no key TTL inflation of the measurement.
// Secrets policy: REDIS_URL / password / username never echoed.
import IORedis from "ioredis";

const url = process.env.REDIS_URL;
if (!url) {
  console.error(JSON.stringify({ error: "REDIS_URL unset" }));
  process.exit(2);
}
const u = new URL(url);
const tlsEnv = String(process.env.REDIS_TLS || "").toLowerCase();
const useTls = u.protocol === "rediss:" ||
  ["1", "true", "yes", "on"].includes(tlsEnv);
const password = decodeURIComponent(u.password || "") || undefined;
const username = decodeURIComponent(u.username || "") || undefined;
const host = u.hostname;
const port = Number(u.port);

const clusterEnv = String(process.env.REDIS_CLUSTER || "").toLowerCase();
const clusterMode = ["1", "true", "yes", "on"].includes(clusterEnv);

function parseInfo(raw) {
  const info = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) info[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return info;
}

let client;
if (clusterMode) {
  client = new IORedis.Cluster(
    [{ host, port }],
    {
      redisOptions: {
        password, username,
        ...(useTls ? { tls: {} } : {}),
      },
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
if (clusterMode) {
  for (const n of client.nodes("master")) {
    const addr = `${n.options.host}:${n.options.port}`;
    const info = parseInfo(await n.call("INFO", "memory"));
    out.per_master[addr] = {
      used_memory_bytes: Number(info.used_memory),
      used_memory_human: info.used_memory_human,
    };
  }
  const total = Object.values(out.per_master)
    .reduce((s, m) => s + (m.used_memory_bytes || 0), 0);
  out.used_memory_bytes = total;
} else {
  const addr = `${host}:${port}`;
  const info = parseInfo(await client.call("INFO", "memory"));
  out.per_master[addr] = {
    used_memory_bytes: Number(info.used_memory),
    used_memory_human: info.used_memory_human,
  };
  out.used_memory_bytes = Number(info.used_memory);
}

console.log(JSON.stringify(out, null, 2));
await client.quit();
