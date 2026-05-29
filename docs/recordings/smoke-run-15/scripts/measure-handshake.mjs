// Wave 5.15p — in-container handshake measurement.
// Constructs the ioredis client using the same env the api reads,
// awaits the 'ready' event, prints `elapsed_ms=<N>`, then disconnects.
// No URL or credentials are ever printed.

import { Cluster, Redis } from "ioredis";

const url = process.env.REDIS_URL;
if (!url) {
  console.error("REDIS_URL not set");
  process.exit(1);
}
const u = new URL(url);
const tlsFromScheme = u.protocol === "rediss:" || u.protocol === "rediss";
const port = u.port ? Number(u.port) : 6379;
const password = u.password ? decodeURIComponent(u.password) : undefined;
const username = u.username ? decodeURIComponent(u.username) : undefined;

function envBool(value, fallback) {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

const clusterMode = envBool(process.env.REDIS_CLUSTER, true);
const tlsEnabled = envBool(process.env.REDIS_TLS, tlsFromScheme);

const redisOptions = {
  ...(password ? { password } : {}),
  ...(username ? { username } : {}),
  ...(tlsEnabled ? { tls: {} } : {}),
  maxRetriesPerRequest: 3,
};

const t0 = Date.now();
let client;
if (clusterMode) {
  client = new Cluster([{ host: u.hostname, port }], {
    redisOptions,
    slotsRefreshTimeout: 5_000,
  });
} else {
  client = new Redis({ host: u.hostname, port, ...redisOptions });
}

const cleanup = async (code) => {
  try { await client.quit(); } catch { /* ignore */ }
  process.exit(code);
};

client.once("ready", () => {
  const elapsed = Date.now() - t0;
  console.log(`elapsed_ms=${elapsed}`);
  void cleanup(0);
});
client.once("error", (err) => {
  const elapsed = Date.now() - t0;
  console.log(`elapsed_ms=${elapsed} err=${String(err?.message ?? err)}`);
  void cleanup(1);
});
setTimeout(() => {
  console.log("elapsed_ms=TIMEOUT_60000");
  void cleanup(2);
}, 60_000);
