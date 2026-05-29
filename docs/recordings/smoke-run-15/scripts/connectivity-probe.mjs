// Wave 5.15o smoke-run-15 — new-cluster connectivity probe.
//
// Purpose: confirm the freshly provisioned Redis Enterprise cluster
// (2.5 GB usable / 5 GB w/ replication) is reachable from this host and
// capture topology + memory ceiling before we re-delegate ingest.
//
// Inputs:  REDIS_URL (consumed via ioredis, never echoed).
// Output:  single JSON object to stdout. Caller redirects to logs file.
// Secrets policy: never log REDIS_URL, password, or url-decoded credentials.
//                 Host/port only ever come from ioredis node options or are
//                 derived locally — never re-serialised from the URL.
import IORedis from "ioredis";
import { randomBytes } from "node:crypto";

const t0 = Date.now();
const u = new URL(process.env.REDIS_URL);
const seed = new IORedis.Cluster(
  [{ host: u.hostname, port: Number(u.port) }],
  {
    redisOptions: {
      password: decodeURIComponent(u.password || ""),
      username: decodeURIComponent(u.username || "") || undefined,
      tls: u.protocol === "rediss:" ? {} : undefined,
    },
    scaleReads: "all",
    lazyConnect: true,
  }
);

const out = {
  probe: "wave-5.15o smoke-run-15 connectivity",
  started_at_ms: t0,
  connect: { ok: false },
  ping: { ok: false },
  cluster: {},
  per_master: {},
  write_path: { ok: false },
};

try {
  await seed.connect();
  out.connect.ok = true;
  out.connect.elapsed_ms = Date.now() - t0;
} catch (e) {
  out.connect.error = String((e && e.message) || e);
  console.log(JSON.stringify(out, null, 2));
  process.exit(2);
}

// PING latency on the seed connection.
const pingStart = Date.now();
try {
  const pong = await seed.ping();
  out.ping.ok = pong === "PONG";
  out.ping.reply = pong;
  out.ping.latency_ms = Date.now() - pingStart;
} catch (e) {
  out.ping.error = String((e && e.message) || e);
}

// CLUSTER INFO — cluster_state, slots_assigned, size.
try {
  const raw = await seed.call("CLUSTER", "INFO");
  const info = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) info[line.slice(0, idx)] = line.slice(idx + 1);
  }
  out.cluster.state = info.cluster_state;
  out.cluster.slots_assigned = Number(info.cluster_slots_assigned);
  out.cluster.slots_ok = Number(info.cluster_slots_ok);
  out.cluster.known_nodes = Number(info.cluster_known_nodes);
  out.cluster.size = Number(info.cluster_size);
} catch (e) {
  out.cluster.error = String((e && e.message) || e);
}

// CLUSTER NODES — map node id → host:port and master vs replica.
let nodesRaw = "";
try {
  nodesRaw = await seed.call("CLUSTER", "NODES");
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

// Slot ranges per master from CLUSTER SLOTS.
try {
  const slotsRaw = await seed.call("CLUSTER", "SLOTS");
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

// Per-master INFO memory.
for (const n of seed.nodes("master")) {
  const addr = `${n.options.host}:${n.options.port}`;
  if (!out.per_master[addr]) out.per_master[addr] = { slot_ranges: [] };
  try {
    const raw = await n.call("INFO", "memory");
    const info = {};
    for (const line of String(raw).split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) info[line.slice(0, idx)] = line.slice(idx + 1);
    }
    out.per_master[addr].maxmemory_bytes = Number(info.maxmemory);
    out.per_master[addr].maxmemory_human = info.maxmemory_human;
    out.per_master[addr].used_memory_bytes = Number(info.used_memory);
    out.per_master[addr].used_memory_human = info.used_memory_human;
    out.per_master[addr].maxmemory_policy = info.maxmemory_policy;
  } catch (e) {
    out.per_master[addr].memory_error = String((e && e.message) || e);
  }
}

// Write-path probe: tiny throwaway key with 5s TTL.
const ulid = randomBytes(8).toString("hex");
const probeKey = `probe:{ping}:${ulid}`;
try {
  const setReply = await seed.set(probeKey, String(Date.now()), "EX", 5);
  out.write_path.ok = setReply === "OK";
  out.write_path.reply = setReply;
  out.write_path.key = probeKey;
  out.write_path.ttl_s = 5;
} catch (e) {
  out.write_path.error = String((e && e.message) || e);
}

out.elapsed_ms = Date.now() - t0;
console.log(JSON.stringify(out, null, 2));
await seed.quit();
