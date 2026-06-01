// Wave 5.15o smoke-run-15 — new-cluster connectivity probe.
//
// Purpose: confirm the freshly provisioned Redis Enterprise endpoint
// (2.5 GB usable / 5 GB w/ replication) is reachable from this host and
// capture topology + memory ceiling before we re-delegate ingest.
//
// Topology handling: tries OSS Cluster API first (smoke-run-14 shape).
// If the seed does not respond to CLUSTER SLOTS (e.g. single-shard
// Redis Cloud DB without OSS Cluster API), falls back to a standalone
// ioredis client and reports a single-primary view.
//
// Inputs:  REDIS_URL (consumed via ioredis, never echoed). REDIS_TLS
//          toggles TLS independently of URL scheme — matches the shared
//          client convention in shared/redis-client/src/index.ts.
// Output:  single JSON object to stdout. Caller redirects to logs file.
// Secrets policy: never log REDIS_URL, password, or url-decoded credentials.
//                 Host/port only ever come from ioredis node options or are
//                 derived locally — never re-serialised from the URL.
import IORedis from "ioredis";
import { randomBytes } from "node:crypto";

const t0 = Date.now();
const u = new URL(process.env.REDIS_URL);
const tlsEnv = String(process.env.REDIS_TLS || "").toLowerCase();
const useTls = u.protocol === "rediss:" ||
  ["1", "true", "yes", "on"].includes(tlsEnv);
const password = decodeURIComponent(u.password || "") || undefined;
const username = decodeURIComponent(u.username || "") || undefined;
const host = u.hostname;
const port = Number(u.port);

const out = {
  probe: "wave-5.15o smoke-run-15 connectivity",
  started_at_ms: t0,
  mode: null,
  tls_used: useTls,
  connect: { ok: false },
  ping: { ok: false },
  cluster: {},
  per_master: {},
  write_path: { ok: false },
};

// --- Phase 1: try OSS Cluster API ----------------------------------------
let seed = new IORedis.Cluster(
  [{ host, port }],
  {
    redisOptions: {
      password,
      username,
      ...(useTls ? { tls: {} } : {}),
    },
    scaleReads: "all",
    lazyConnect: true,
    slotsRefreshTimeout: 5_000,
  }
);
seed.on("error", () => { /* swallow — phase classifier inspects exceptions */ });

let clusterOk = false;
try {
  await seed.connect();
  clusterOk = true;
  out.mode = "cluster";
  out.connect.ok = true;
  out.connect.elapsed_ms = Date.now() - t0;
} catch (e) {
  out.connect.cluster_attempt_error = String((e && e.message) || e);
  try { seed.disconnect(); } catch {}
}

// --- Phase 2: fall back to standalone if cluster bootstrap failed --------
let standalone = null;
if (!clusterOk) {
  standalone = new IORedis({
    host, port, password, username,
    ...(useTls ? { tls: {} } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 8_000,
  });
  standalone.on("error", () => { /* surfaced via try/catch below */ });
  try {
    await standalone.connect();
    out.mode = "standalone";
    out.connect.ok = true;
    out.connect.elapsed_ms = Date.now() - t0;
  } catch (e) {
    out.connect.standalone_attempt_error = String((e && e.message) || e);
    console.log(JSON.stringify(out, null, 2));
    try { standalone.disconnect(); } catch {}
    process.exit(2);
  }
}

// Bind `client` to whichever phase succeeded for the rest of the probe.
const client = clusterOk ? seed : standalone;

function parseInfo(raw) {
  const info = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) info[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return info;
}

// PING latency on the primary client.
const pingStart = Date.now();
try {
  const pong = await client.ping();
  out.ping.ok = pong === "PONG";
  out.ping.reply = pong;
  out.ping.latency_ms = Date.now() - pingStart;
} catch (e) {
  out.ping.error = String((e && e.message) || e);
}

// CLUSTER INFO — only meaningful in cluster mode, but standalone Redis
// also accepts the command and reports cluster_enabled:0.
try {
  const raw = await client.call("CLUSTER", "INFO");
  const info = parseInfo(raw);
  out.cluster.state = info.cluster_state;
  out.cluster.enabled = info.cluster_enabled;
  out.cluster.slots_assigned = Number(info.cluster_slots_assigned);
  out.cluster.slots_ok = Number(info.cluster_slots_ok);
  out.cluster.known_nodes = Number(info.cluster_known_nodes);
  out.cluster.size = Number(info.cluster_size);
} catch (e) {
  out.cluster.error = String((e && e.message) || e);
}

if (clusterOk) {
  // ---- Cluster-mode topology ------------------------------------------
  let nodesRaw = "";
  try {
    nodesRaw = await client.call("CLUSTER", "NODES");
  } catch (e) {
    out.cluster.nodes_error = String((e && e.message) || e);
  }
  const masterAddrs = [];
  const allNodes = [];
  for (const line of String(nodesRaw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(" ");
    // <id> <ip:port@cport[,hostname]> <flags> <master> ...
    const ep = parts[1] || "";
    const hostPort = ep.split("@")[0].split(",")[0];
    const flags = (parts[2] || "").split(",");
    const isMaster = flags.includes("master");
    const isReplica = flags.includes("slave") || flags.includes("replica");
    allNodes.push({ addr: hostPort, role: isMaster ? "master" : isReplica ? "replica" : "other", flags });
    if (isMaster) masterAddrs.push(hostPort);
  }
  out.cluster.master_count = masterAddrs.length;
  out.cluster.node_count = allNodes.length;
  out.cluster.nodes = allNodes;

  try {
    const slotsRaw = await client.call("CLUSTER", "SLOTS");
    if (Array.isArray(slotsRaw)) {
      for (const range of slotsRaw) {
        if (!Array.isArray(range) || range.length < 3) continue;
        const start = range[0], end = range[1];
        const m = range[2];
        if (!Array.isArray(m) || m.length < 2) continue;
        const addr = `${m[0]}:${m[1]}`;
        if (!out.per_master[addr]) out.per_master[addr] = { slot_ranges: [] };
        out.per_master[addr].slot_ranges.push([start, end]);
      }
    }
  } catch (e) {
    out.cluster.slots_error = String((e && e.message) || e);
  }

  for (const n of client.nodes("master")) {
    const addr = `${n.options.host}:${n.options.port}`;
    if (!out.per_master[addr]) out.per_master[addr] = { slot_ranges: [] };
    try {
      const info = parseInfo(await n.call("INFO", "memory"));
      out.per_master[addr].maxmemory_bytes = Number(info.maxmemory);
      out.per_master[addr].maxmemory_human = info.maxmemory_human;
      out.per_master[addr].used_memory_bytes = Number(info.used_memory);
      out.per_master[addr].used_memory_human = info.used_memory_human;
      out.per_master[addr].maxmemory_policy = info.maxmemory_policy;
    } catch (e) {
      out.per_master[addr].memory_error = String((e && e.message) || e);
    }
  }
} else {
  // ---- Standalone-mode topology --------------------------------------
  // Single primary; INFO replication tells us whether a replica is attached.
  const addr = `${host}:${port}`;
  out.per_master[addr] = { slot_ranges: [[0, 16383]] };
  out.cluster.master_count = 1;
  try {
    const info = parseInfo(await client.call("INFO", "memory"));
    out.per_master[addr].maxmemory_bytes = Number(info.maxmemory);
    out.per_master[addr].maxmemory_human = info.maxmemory_human;
    out.per_master[addr].used_memory_bytes = Number(info.used_memory);
    out.per_master[addr].used_memory_human = info.used_memory_human;
    out.per_master[addr].maxmemory_policy = info.maxmemory_policy;
  } catch (e) {
    out.per_master[addr].memory_error = String((e && e.message) || e);
  }
  try {
    const info = parseInfo(await client.call("INFO", "replication"));
    out.per_master[addr].role = info.role;
    out.per_master[addr].connected_replicas = Number(info.connected_slaves || 0);
  } catch (e) {
    out.per_master[addr].replication_error = String((e && e.message) || e);
  }
  try {
    const info = parseInfo(await client.call("INFO", "server"));
    out.per_master[addr].redis_version = info.redis_version;
    out.per_master[addr].redis_mode = info.redis_mode;
  } catch (e) {
    out.per_master[addr].server_error = String((e && e.message) || e);
  }
}

// Write-path probe: tiny throwaway key with 5s TTL. The {ping} hash tag
// keeps the key on a single slot in cluster mode and is harmless in
// standalone mode (it's just a literal substring of the key name).
const ulid = randomBytes(8).toString("hex");
const probeKey = `probe:{ping}:${ulid}`;
try {
  const setReply = await client.set(probeKey, String(Date.now()), "EX", 5);
  out.write_path.ok = setReply === "OK";
  out.write_path.reply = setReply;
  out.write_path.key = probeKey;
  out.write_path.ttl_s = 5;
} catch (e) {
  out.write_path.error = String((e && e.message) || e);
}

out.elapsed_ms = Date.now() - t0;
console.log(JSON.stringify(out, null, 2));
await client.quit();
