#!/usr/bin/env node
// scripts/connection-spread-probe.mjs — Wave 7.0.6.5
//
// 450M pre-flight Gate 3: proves the Redis Enterprise proxy fans connections
// out across all master shards. Opens N concurrent non-cluster ioredis
// connections via the shared factory, runs CLIENT ID + CLIENT SETNAME on
// each so the operator can correlate them via `rladmin` `CLIENT LIST` on
// each master node, then emits a JSON report and exits.
//
// Usage:
//   node scripts/connection-spread-probe.mjs --endpoint <host:port> \
//     [--connections N] [--tolerance F] [--timeout-ms MS]
//
// Defaults: connections=32, tolerance=0.20, timeout-ms=5000.
// REDIS_URL (if set) overrides --endpoint so ops can carry auth through env
// without exposing it on argv (matches scripts/capture-shard-snapshot.sh).
//
// Secrets policy: NEVER echo REDIS_URL, password, or url-decoded credentials
// to stdout/stderr. The JSON report contains only host:port + client_id +
// client_name (the probe tag we set).
//
// Exit codes:
//   0  all connections established and CLIENT ID returned a number.
//   1  any connection failed to establish OR any CLIENT ID command failed
//      within --timeout-ms.
//   2  usage error (missing required flag, bad value).

import { createRedisClient } from "@frtb/redis-client";

const DEFAULTS = { connections: 32, tolerance: 0.20, timeoutMs: 5000 };

export function parseArgs(argv) {
  const args = { ...DEFAULTS, endpoint: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--endpoint") args.endpoint = next();
    else if (a === "--connections") args.connections = Number(next());
    else if (a === "--tolerance") args.tolerance = Number(next());
    else if (a === "--timeout-ms") args.timeoutMs = Number(next());
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a?.startsWith("--")) throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function helpText() {
  return [
    "Usage: node scripts/connection-spread-probe.mjs --endpoint <host:port>",
    "       [--connections N=32] [--tolerance F=0.20] [--timeout-ms MS=5000]",
    "",
    "Env: REDIS_URL overrides --endpoint for auth-bearing endpoints.",
  ].join("\n");
}

function parseEndpoint(ep) {
  const m = (ep ?? "").match(/^([^:]+):(\d+)$/);
  if (!m) throw new Error(`--endpoint must be <host:port>, got: ${ep ?? "<missing>"}`);
  return { host: m[1], port: Number(m[2]) };
}

function withTimeout(promise, ms, label) {
  let to;
  const t = new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`${label} timeout >${ms}ms`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(to)), t]);
}

// runProbe is exported for unit tests. createClient(i, name) returns a
// connected ioredis-compatible client (must expose .call() and .quit()).
export async function runProbe({ connections, timeoutMs, createClient }) {
  const t0 = Date.now();
  const probeTag = `csprobe-${process.pid}-${t0}`;
  const established = [];
  const failures = [];
  const clients = [];

  await Promise.all(Array.from({ length: connections }, async (_, i) => {
    const client_name = `${probeTag}-${i}`;
    let client;
    try {
      client = await withTimeout(Promise.resolve(createClient(i, client_name)), timeoutMs, "connect");
      clients.push(client);
      const id = await withTimeout(client.call("CLIENT", "ID"), timeoutMs, "CLIENT ID");
      await withTimeout(client.call("CLIENT", "SETNAME", client_name), timeoutMs, "CLIENT SETNAME");
      const client_id = Number(id);
      if (!Number.isFinite(client_id)) throw new Error(`CLIENT ID returned non-numeric: ${id}`);
      established.push({ index: i, client_id, client_name });
    } catch (err) {
      failures.push({ index: i, error: String(err?.message ?? err) });
    }
  }));

  const elapsed_ms = Date.now() - t0;
  await Promise.all(clients.map((c) => {
    try { return Promise.resolve(c.quit?.()).catch(() => undefined); }
    catch { return undefined; }
  }));

  return {
    probe_tag: probeTag,
    requested: connections,
    established: established.length,
    failed: failures.length,
    elapsed_ms,
    connections: established.sort((a, b) => a.index - b.index),
    failures: failures.sort((a, b) => a.index - b.index),
  };
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`ERROR: ${e.message}\n${helpText()}`); process.exit(2); }
  if (args.help) { console.log(helpText()); process.exit(0); }
  if (!args.endpoint && !process.env.REDIS_URL) {
    console.error(`ERROR: --endpoint or REDIS_URL is required\n${helpText()}`);
    process.exit(2);
  }
  if (!Number.isFinite(args.connections) || args.connections <= 0) {
    console.error("ERROR: --connections must be a positive integer"); process.exit(2);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    console.error("ERROR: --timeout-ms must be a positive integer"); process.exit(2);
  }

  // Build URL from --endpoint when REDIS_URL is not set. We never log either.
  const url = process.env.REDIS_URL ?? (() => {
    const { host, port } = parseEndpoint(args.endpoint);
    return `redis://${host}:${port}`;
  })();

  const createClient = () => createRedisClient({
    url,
    cluster: false,
    lazyConnect: false,
    connectTimeout: args.timeoutMs,
    commandTimeout: args.timeoutMs,
    maxRetriesPerRequest: 1,
  });

  const report = await runProbe({
    connections: args.connections,
    timeoutMs: args.timeoutMs,
    createClient,
  });
  const out = { ...report, tolerance: args.tolerance };
  console.log(JSON.stringify(out, null, 2));
  if (out.failed > 0) process.exit(1);
}

// Only run main() when invoked directly — tests import runProbe instead.
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
