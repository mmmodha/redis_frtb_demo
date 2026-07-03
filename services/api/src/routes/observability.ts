import type { FastifyInstance } from "fastify";
import { Cluster } from "ioredis";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget, type RuntimeCategory } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateObservabilityRedisError } from "../redis-errors.ts";
import { corsHeadersForRequest } from "../cors-headers.ts";
import {
  RETENTION_MS,
  isValidMetric,
  readHistory,
  writeMetric,
} from "../lib/timeseries.ts";
import { listRecentRuns } from "../calc/recent-runs.ts";
import { getSensKeyCountSnapshot } from "../lib/sens-key-count-cache.ts";

const NUMERIC_INFO_FIELDS = new Set([
  "used_memory",
  "used_memory_peak",
  "used_memory_rss",
  "used_memory_dataset",
  "maxmemory",
  "mem_fragmentation_ratio",
  "total_system_memory",
  "total_net_input_bytes",
  "total_net_output_bytes",
  "instantaneous_ops_per_sec",
]);

function parseInfo(text: string): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx);
    const v = line.slice(idx + 1);
    if (NUMERIC_INFO_FIELDS.has(k)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface KeysQuery { prefix?: string }

export interface Shard {
  shardId: string;
  role: string;
  opsPerSec: number;
  slotCount: number;
  usedMemoryBytes: number;
  netInBytes: number;
  netOutBytes: number;
}

interface ParsedNode {
  id: string;
  role: "master" | "slave";
  slotCount: number;
  // `<host>:<port>` extracted from `parts[1]` (`<ip:port@cport[,hostname]>`).
  // Used by readShards() to stitch per-node INFO into the matching shard tile.
  endpoint: string;
}

// CLUSTER NODES line layout (per https://redis.io/commands/cluster-nodes/):
//   <id> <ip:port@cport[,hostname]> <flags> <master> <ping> <pong>
//   <epoch> <link-state> <slot> <slot> ...
// `flags` is comma-separated and may contain "myself", "master", "slave",
// "fail", etc. We treat anything tagged "master" (with or without "myself") as
// a primary; slaves are excluded from the shards list.
export function parseClusterNodes(text: string): ParsedNode[] {
  const out: ParsedNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const id = parts[0] ?? "";
    const addr = parts[1] ?? "";
    // Strip `@cport` and optional `,hostname` to get the bare host:port that
    // ioredis Cluster sub-clients expose on `.options.host`/`.options.port`.
    const atIdx = addr.indexOf("@");
    const endpoint = atIdx >= 0 ? addr.slice(0, atIdx) : addr.split(",")[0] ?? addr;
    const flags = (parts[2] ?? "").split(",");
    const isMaster = flags.includes("master");
    const isSlave = flags.includes("slave");
    if (!isMaster && !isSlave) continue;
    let slotCount = 0;
    for (let i = 8; i < parts.length; i++) {
      const slot = parts[i] ?? "";
      if (!slot || slot.startsWith("[")) continue; // importing/migrating markers
      const dash = slot.indexOf("-");
      if (dash >= 0) {
        const lo = Number(slot.slice(0, dash));
        const hi = Number(slot.slice(dash + 1));
        if (Number.isFinite(lo) && Number.isFinite(hi)) slotCount += hi - lo + 1;
      } else {
        const n = Number(slot);
        if (Number.isFinite(n)) slotCount += 1;
      }
    }
    out.push({ id, role: isMaster ? "master" : "slave", slotCount, endpoint });
  }
  return out;
}

// Wave 5.16i — Synthesise a single-element Shard[] for non-clustered targets
// (standalone Redis, Redis Cloud shared tiers, etc. where CLUSTER NODES is
// blocked with `ERR command is not allowed`). The UI's ObservabilityShard
// shape is the contract; slotCount=0 conveys "no slots" without claiming the
// full 16384.
async function buildStandaloneShards(redis: RedisLike): Promise<Shard[]> {
  const [memText, statsText] = await Promise.all([
    redis.info("memory"),
    redis.info("stats"),
  ]);
  const mem = parseInfo(memText);
  const stats = parseInfo(statsText);
  return [
    {
      shardId: "standalone",
      role: "master",
      opsPerSec: Number(stats.instantaneous_ops_per_sec ?? 0),
      slotCount: 0,
      usedMemoryBytes: Number(mem.used_memory ?? 0),
      netInBytes: Number(stats.total_net_input_bytes ?? 0),
      netOutBytes: Number(stats.total_net_output_bytes ?? 0),
    },
  ];
}

// Minimal logger surface — Fastify's `req.log` (pino) satisfies this; tests
// can pass a stub or nothing at all.
export interface ShardLogger {
  warn: (obj: Record<string, unknown>) => void;
}

// Wave 5.85 — minimal ioredis Cluster sub-client surface used by the per-node
// INFO fan-out. Real `ioredis.Cluster.nodes("master")` returns `Redis[]` whose
// instances expose `.info(section)` and an `.options` bag with `host`/`port`.
// Typed loosely here so the unit-test fakeRedis can plug into the same path
// without booting a real cluster.
export interface ClusterSubClient {
  info: (section?: string) => Promise<string>;
  options?: { host?: string; port?: number | string };
}

export interface ClusterFanoutClient {
  nodes: (role?: "master" | "slave" | "all") => ClusterSubClient[];
}

// Cluster detection: real ioredis Cluster (instanceof) OR an object that
// duck-types `.nodes(role)` as a function. The duck-type fallback exists so
// unit tests can inject a fake without constructing a real Cluster. NOTE:
// per-node topology probing on a non-Cluster ioredis Redis client is not
// supported — that path keeps the single-INFO fallback (today's behaviour).
function asClusterClient(redis: unknown): ClusterFanoutClient | null {
  if (redis instanceof Cluster) return redis as unknown as ClusterFanoutClient;
  if (redis && typeof (redis as { nodes?: unknown }).nodes === "function") {
    return redis as ClusterFanoutClient;
  }
  return null;
}

interface PerNodeInfo {
  usedMemoryBytes: number;
  netInBytes: number;
  netOutBytes: number;
  opsPerSec: number;
}

// Fan `INFO memory` + `INFO stats` out across every master sub-client and
// return a map keyed by `host:port` (matching ParsedNode.endpoint). Sub-clients
// that fail are skipped — the caller falls back to single-INFO for any shard
// missing from the map.
async function readPerNodeInfo(
  cluster: ClusterFanoutClient,
  log?: ShardLogger,
): Promise<Map<string, PerNodeInfo>> {
  const masters = cluster.nodes("master") ?? [];
  const map = new Map<string, PerNodeInfo>();
  await Promise.all(
    masters.map(async (node) => {
      const host = node.options?.host ?? "";
      const port = node.options?.port ?? "";
      const endpoint = `${host}:${port}`;
      try {
        const [memText, statsText] = await Promise.all([
          node.info("memory"),
          node.info("stats"),
        ]);
        const mem = parseInfo(memText);
        const stats = parseInfo(statsText);
        map.set(endpoint, {
          usedMemoryBytes: Number(mem.used_memory ?? 0),
          netInBytes: Number(stats.total_net_input_bytes ?? 0),
          netOutBytes: Number(stats.total_net_output_bytes ?? 0),
          opsPerSec: Number(stats.instantaneous_ops_per_sec ?? 0),
        });
      } catch (err) {
        log?.warn?.({
          warn: "observability-shards-per-node-info-failed",
          endpoint,
          reason: String(err),
        });
      }
    }),
  );
  return map;
}

export async function readShards(
  redis: RedisLike,
  log?: ShardLogger,
): Promise<Shard[]> {
  // Detect topology BEFORE calling CLUSTER NODES so standalone tiers (Redis
  // Cloud shared, etc.) don't surface as a 500. `INFO cluster` is permitted
  // on every tier. When `cluster_enabled` is missing from INFO we default to
  // the cluster path so the pre-5.16i contract is preserved verbatim for the
  // Wave 5.5 cluster-mode demos.
  let clusterEnabled: string | undefined;
  try {
    const text = await redis.info("cluster");
    const parsed = parseInfo(text);
    const ce = parsed.cluster_enabled;
    clusterEnabled = ce === undefined ? undefined : String(ce);
  } catch {
    clusterEnabled = undefined;
  }
  if (clusterEnabled === "0") {
    return buildStandaloneShards(redis);
  }

  try {
    const [nodesText, infoText] = await Promise.all([
      redis.call("CLUSTER", "NODES") as Promise<string>,
      redis.info(),
    ]);
    const parsed = parseClusterNodes(typeof nodesText === "string" ? nodesText : "");
    const info = parseInfo(infoText);
    // Single-INFO numbers — used as a per-shard fallback when the per-node
    // fan-out can't reach a given endpoint (or when redis isn't a Cluster
    // client at all). Pre-Wave-5.85, every tile carried these identical values.
    const fbUsedMemoryBytes = Number(info.used_memory ?? 0);
    const fbNetInBytes = Number(info.total_net_input_bytes ?? 0);
    const fbNetOutBytes = Number(info.total_net_output_bytes ?? 0);
    const fbOpsPerSec = Number(info.instantaneous_ops_per_sec ?? 0);

    // Wave 5.85 — fan INFO out across master sub-clients so each tile carries
    // that node's own memory/network/ops. `nodes("master")` can briefly return
    // [] during a slot-table refresh; treat that as "not yet" and fall back to
    // the single-INFO numbers rather than throwing.
    const cluster = asClusterClient(redis);
    let perNode: Map<string, PerNodeInfo> | null = null;
    if (cluster) {
      perNode = await readPerNodeInfo(cluster, log);
      if (perNode.size === 0) {
        log?.warn?.({
          warn: "observability-shards-cluster-nodes-empty",
          reason: "nodes('master') returned [] — slot-table refresh? falling back to single INFO",
        });
        perNode = null;
      }
    }

    return parsed
      .filter((n) => n.role === "master")
      .map((n) => {
        const pn = perNode?.get(n.endpoint);
        return {
          shardId: n.id.slice(0, 8),
          role: n.role,
          opsPerSec: pn?.opsPerSec ?? fbOpsPerSec,
          slotCount: n.slotCount,
          usedMemoryBytes: pn?.usedMemoryBytes ?? fbUsedMemoryBytes,
          netInBytes: pn?.netInBytes ?? fbNetInBytes,
          netOutBytes: pn?.netOutBytes ?? fbNetOutBytes,
        };
      });
  } catch (err) {
    // Defensive fallback: managed DBs that report `cluster_enabled:1` but
    // still block the CLUSTER command (some Redis Cloud configurations) hit
    // this branch. Case-insensitive substring match because the exact wording
    // ("ERR command is not allowed") may shift across versions.
    const reason = String(err);
    if (reason.toLowerCase().includes("not allowed")) {
      log?.warn?.({
        warn: "observability-shards-standalone-fallback",
        reason,
      });
      return buildStandaloneShards(redis);
    }
    throw err;
  }
}

// Wave 7.0.4.A — Per-shard observability endpoint backed by an operator-side
// `rladmin info shards` snapshot written to the Redis key
// `ops:per-shard-snapshot` by scripts/capture-shard-snapshot.sh. The API
// service never SSHes into the cluster — it only reads the snapshot key.
const PER_SHARD_SNAPSHOT_KEY = "ops:per-shard-snapshot";
const PER_SHARD_STALENESS_MS = 30_000;

// Wave 7.0.6.5 — parser implementation moved to ../lib/rladmin-parser.mjs so
// plain-Node scripts (scripts/assert-shard-balance.mjs) can import the same
// parser via `node` without tsx. Re-exported here so existing imports
// (observability tests, route code) keep working unchanged.
import {
  parseRladminMemory,
  parseRladminShards,
  type RladminShardRow,
} from "../lib/rladmin-parser.mjs";
export { parseRladminMemory, parseRladminShards, type RladminShardRow };

export interface PerShardExtras {
  key_count?: number | null;
  write_ops_per_sec?: number | null;
  index_lag?: number | null;
}

// Snapshot envelope written by scripts/capture-shard-snapshot.sh. Either
// `shards_raw` (rladmin table; parsed here) or `shards` (already-extracted
// rows) is required. `extras` carries per-shard stats that rladmin doesn't
// expose (key_count, write_ops_per_sec, index_lag) — keyed by shard_id.
export interface PerShardSnapshotEnvelope {
  captured_at: string;
  shards_raw?: string;
  shards?: Array<{
    shard_id: string;
    role: string;
    memory_used?: number;
  } & PerShardExtras>;
  extras?: Record<string, PerShardExtras>;
}

export interface PerShardRow {
  shard_id: string;
  role: string;
  memory_used: number;
  key_count: number | null;
  write_ops_per_sec: number | null;
  index_lag: number | null;
  last_observed_at: string | null;
  snapshot_age_seconds: number | null;
  degraded?: true;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Wave 7.0.4.A — degraded fallback when no fresh snapshot is available.
// Returns a single aggregated row built from `INFO memory` + `INFO stats` +
// `DBSIZE` so the UI still has *something* to render. `index_lag` is null
// because the API service can't enumerate per-shard FT.INFO without the
// snapshot script's per-port redis-cli probes.
async function buildDegradedPerShardRow(
  redis: RedisLike,
  capturedAt: string | null,
  ageSeconds: number | null,
): Promise<PerShardRow> {
  const [memText, statsText, dbsize] = await Promise.all([
    redis.info("memory"),
    redis.info("stats"),
    redis.dbsize(),
  ]);
  const mem = parseInfo(memText);
  const stats = parseInfo(statsText);
  return {
    shard_id: "aggregate",
    role: "master",
    memory_used: Number(mem.used_memory ?? 0),
    key_count: Number.isFinite(Number(dbsize)) ? Number(dbsize) : null,
    write_ops_per_sec: numOrNull(stats.instantaneous_ops_per_sec),
    index_lag: null,
    last_observed_at: capturedAt,
    snapshot_age_seconds: ageSeconds,
    degraded: true,
  };
}

// Wave 5.85 — debug aid for "is the api seeing my cluster?". Returns the
// parsed CLUSTER NODES list joined to the per-master INFO summary. Read-only,
// no metric writes, no side effects. Standalone targets return an empty
// `nodes` array and an empty `perNode` map so the response shape is stable.
export interface TopologyPayload {
  nodes: ParsedNode[];
  perNode: Record<string, PerNodeInfo>;
  clusterClient: boolean;
}

export async function readTopology(
  redis: RedisLike,
  log?: ShardLogger,
): Promise<TopologyPayload> {
  const cluster = asClusterClient(redis);
  let nodes: ParsedNode[] = [];
  try {
    const nodesText = await (redis.call("CLUSTER", "NODES") as Promise<string>);
    nodes = parseClusterNodes(typeof nodesText === "string" ? nodesText : "");
  } catch {
    // CLUSTER blocked or standalone — leave nodes empty.
  }
  const perNode = cluster ? await readPerNodeInfo(cluster, log) : new Map<string, PerNodeInfo>();
  return {
    nodes,
    perNode: Object.fromEntries(perNode),
    clusterClient: cluster !== null,
  };
}

export interface RegisterObservabilityOpts {
  sseIntervalMs?: number;
  // Wave 5.21i — resolved @fastify/cors allow-list value. Threaded in so the
  // hijacked /observability/shards/stream response carries the matching
  // access-control-allow-origin header (the cors plugin's onSend hook is
  // bypassed by reply.hijack()).
  corsAllowed?: true | string | string[];
}

export function registerObservabilityRoutes(
  app: FastifyInstance,
  // Wave 6.56.D4 — async accessor.
  getRedis: (category?: RuntimeCategory) => RedisLike | Promise<RedisLike>,
  opts: RegisterObservabilityOpts = {},
): void {
  const sseIntervalMs = opts.sseIntervalMs ?? 1000;
  const corsAllowed = opts.corsAllowed ?? "http://localhost:3000";
  // Wave 6.21 (B1) — every route in this file is small-payload read/stream
  // work (INFO, SCAN sample, CLUSTER NODES, TS.RANGE, shards roll-up); each
  // declares `config: { category: "light" }` so the onRequest hook in
  // server.ts sets `req.poolCategory = "light"` BEFORE the handler runs.
  // Handlers MUST resolve the category from `req` (not hardcode "light") so
  // 6.23's preHandler semaphore reads it from the route metadata. VM evidence
  // from 2026-06-17 showed a single slow calc query pushing all observability
  // calls to multi-second latencies — keeping these on the light pool is
  // what eliminates that head-of-line blocking.
  app.get<{ Querystring: KeysQuery }>(
    "/observability/keys",
    { config: { category: "light" } },
    async (req, reply) => {
    const prefix = req.query.prefix ?? "sens:";
    // Wave 5.16t — resolve active redis per-request so a profile switch is
    // picked up on the very next observability call.
    const redis = await getRedis(req.poolCategory);
    const target_label = getActiveTarget().label;
    const t0 = process.hrtime.bigint();
    try {
      const [, keys] = await redis.scan("0", "MATCH", `${prefix}*`, "COUNT", "1000");
      const dbsize = await redis.dbsize();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      // Wave 5.57 — fire-and-forget TimeSeries write. writeMetric() swallows
      // every error internally so an unavailable module or a failed TS.ADD
      // cannot break the snapshot response.
      void writeMetric(redis, "total_keys", dbsize, target_label);
      return {
        prefix,
        dbsize,
        sample: keys.slice(0, 50),
        sample_size: Math.min(keys.length, 50),
        ms: Math.round(ms * 1000) / 1000,
      };
    } catch (err) {
      const translated = translateObservabilityRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  app.get("/observability/memory", { config: { category: "light" } }, async (req, reply) => {
    const redis = await getRedis(req.poolCategory);
    const target_label = getActiveTarget().label;
    const t0 = process.hrtime.bigint();
    try {
      const [text, statsText, dbsize] = await Promise.all([
        redis.info("memory"),
        redis.info("stats"),
        redis.dbsize(),
      ]);
      const parsed = parseInfo(text);
      const statsParsed = parseInfo(statsText);
      const instantaneous_ops_per_sec = Number(statsParsed.instantaneous_ops_per_sec ?? 0);
      // Wave 5.20a — surface cluster capacity for the UI's pre-submit sanity
      // check. `maxmemory_bytes`/`total_system_memory_bytes` are the same
      // numeric values already parsed from INFO memory under their canonical
      // keys; the `_bytes` suffix mirrors the UI contract.
      const maxmemory_bytes = Number(parsed.maxmemory ?? 0);
      const total_system_memory_bytes = Number(parsed.total_system_memory ?? 0);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const used_memory_bytes = Number(parsed.used_memory ?? 0);
      void writeMetric(redis, "memory_used_bytes", used_memory_bytes, target_label);
      void writeMetric(redis, "ops_per_sec", instantaneous_ops_per_sec, target_label);
      return {
        ...parsed,
        maxmemory_bytes,
        total_system_memory_bytes,
        dbsize,
        instantaneous_ops_per_sec,
        ms: Math.round(ms * 1000) / 1000,
      };
    } catch (err) {
      const translated = translateObservabilityRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  // Wave 7.1 — single poll bundle for the Observability page cluster + calc
  // snapshot. Omits shard topology (unreliable on standalone/proxy targets).
  // Active jobs / stream / drift stay on dedicated endpoints the UI polls
  // from child cards.
  app.get<{ Querystring: { prefix?: string; calc_limit?: string } }>(
    "/observability/debug",
    { config: { category: "light" } },
    async (req, reply) => {
      const prefix = req.query.prefix ?? "sens:";
      const redis = await getRedis(req.poolCategory);
      let target_label = "";
      try { target_label = getActiveTarget().label; } catch { /* no target */ }
      const bootstrap = getBootstrapStatus();
      const calcLimitRaw = Number(req.query.calc_limit);
      const calcLimit = Number.isFinite(calcLimitRaw) && calcLimitRaw > 0
        ? Math.min(Math.floor(calcLimitRaw), 20)
        : 10;
      try {
        const t0 = process.hrtime.bigint();
        const [, keys] = await redis.scan("0", "MATCH", `${prefix}*`, "COUNT", "1000");
        const [memText, statsText, dbsize] = await Promise.all([
          redis.info("memory"),
          redis.info("stats"),
          redis.dbsize(),
        ]);
        const parsed = parseInfo(memText);
        const statsParsed = parseInfo(statsText);
        const maxmemory_bytes = Number(parsed.maxmemory ?? 0);
        const total_system_memory_bytes = Number(parsed.total_system_memory ?? 0);
        const used_memory_bytes = Number(parsed.used_memory ?? 0);
        const instantaneous_ops_per_sec = Number(statsParsed.instantaneous_ops_per_sec ?? 0);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        void writeMetric(redis, "total_keys", dbsize, target_label);
        void writeMetric(redis, "memory_used_bytes", used_memory_bytes, target_label);
        void writeMetric(redis, "ops_per_sec", instantaneous_ops_per_sec, target_label);
        const index_count = target_label
          ? await getSensKeyCountSnapshot(target_label, redis)
          : { count: 0, refreshing: false, index_name: null };
        return {
          keys: {
            prefix,
            dbsize,
            sample: keys.slice(0, 50),
            sample_size: Math.min(keys.length, 50),
            ms: Math.round(ms * 1000) / 1000,
          },
          memory: {
            ...parsed,
            used_memory: used_memory_bytes,
            maxmemory_bytes,
            total_system_memory_bytes,
            dbsize,
            instantaneous_ops_per_sec,
            ms: Math.round(ms * 1000) / 1000,
          },
          index_count,
          calc_recent: { items: listRecentRuns(calcLimit) },
          bootstrap: {
            phase: bootstrap.phase,
            target_label: bootstrap.target_label ?? target_label,
            err: bootstrap.err ?? null,
          },
        };
      } catch (err) {
        const translated = translateObservabilityRedisError(err, target_label, bootstrap.phase);
        if (translated) {
          reply.code(translated.status);
          return translated.body;
        }
        throw err;
      }
    },
  );

  app.get("/observability/shards", { config: { category: "light" } }, async (req, reply) => {
    const redis = await getRedis(req.poolCategory);
    const target_label = getActiveTarget().label;
    try {
      const shards = await readShards(redis, req.log);
      const totalOps = shards.reduce((acc, s) => acc + (s.opsPerSec ?? 0), 0);
      void writeMetric(redis, "shard_count", shards.length, target_label);
      void writeMetric(redis, "ops_per_sec", totalOps, target_label);
      return shards;
    } catch (err) {
      const translated = translateObservabilityRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  // Wave 5.85 — debug aid: surface the parsed CLUSTER NODES + per-node INFO
  // summary so an operator can answer "is the api seeing my cluster?". Read
  // only, no metric writes. Standalone targets return empty arrays/maps.
  app.get("/observability/topology", { config: { category: "light" } }, async (req, reply) => {
    const redis = await getRedis(req.poolCategory);
    const target_label = getActiveTarget().label;
    try {
      const topology = await readTopology(redis, req.log);
      return topology;
    } catch (err) {
      const translated = translateObservabilityRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  // Wave 7.0.4.A — per-shard observability backed by the operator-side
  // `rladmin info shards` snapshot. Reads the snapshot envelope from the
  // Redis key `ops:per-shard-snapshot`; falls back to a single aggregated
  // INFO row tagged `degraded: true` when no snapshot is present or the
  // snapshot is older than PER_SHARD_STALENESS_MS (30s). The API service
  // never SSHes — capture-shard-snapshot.sh runs on a cluster node.
  app.get("/observability/per-shard", { config: { category: "light" } }, async (req, reply) => {
    const redis = await getRedis(req.poolCategory);
    const target_label = getActiveTarget().label;
    try {
      const now = Date.now();
      let envelope: PerShardSnapshotEnvelope | null = null;
      let parseError: string | null = null;
      try {
        const raw = await redis.call("GET", PER_SHARD_SNAPSHOT_KEY);
        if (typeof raw === "string" && raw.length > 0) {
          try {
            envelope = JSON.parse(raw) as PerShardSnapshotEnvelope;
          } catch (err) {
            parseError = String(err);
            req.log.warn({
              warn: "per-shard-snapshot-parse-failed",
              reason: parseError,
            });
          }
        }
      } catch (err) {
        const translated = translateObservabilityRedisError(err, target_label, getBootstrapStatus().phase);
        if (translated) {
          reply.code(translated.status);
          return translated.body;
        }
        throw err;
      }

      const capturedAtRaw = envelope?.captured_at ?? null;
      const capturedAtMs = capturedAtRaw ? Date.parse(capturedAtRaw) : NaN;
      const ageMs = Number.isFinite(capturedAtMs) ? now - capturedAtMs : Infinity;
      const ageSec = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null;
      const fresh =
        envelope !== null &&
        Number.isFinite(capturedAtMs) &&
        ageMs >= 0 &&
        ageMs <= PER_SHARD_STALENESS_MS;

      if (!fresh) {
        return [await buildDegradedPerShardRow(redis, capturedAtRaw, ageSec)];
      }

      const env = envelope as PerShardSnapshotEnvelope;
      const baseRows: Array<{
        shard_id: string;
        role: string;
        memory_used: number;
        extras: PerShardExtras;
      }> = [];
      if (Array.isArray(env.shards)) {
        for (const s of env.shards) {
          if (!s || typeof s.shard_id !== "string") continue;
          if (s.role !== "master") continue;
          baseRows.push({
            shard_id: s.shard_id,
            role: s.role,
            memory_used: Number(s.memory_used ?? 0),
            extras: {
              key_count: numOrNull(s.key_count),
              write_ops_per_sec: numOrNull(s.write_ops_per_sec),
              index_lag: numOrNull(s.index_lag),
            },
          });
        }
      } else if (typeof env.shards_raw === "string") {
        const parsed = parseRladminShards(env.shards_raw);
        for (const p of parsed) {
          if (p.role !== "master") continue;
          baseRows.push({
            shard_id: p.shard_id,
            role: p.role,
            memory_used: p.memory_used,
            extras: {},
          });
        }
      }

      const extras = env.extras ?? {};
      const rows: PerShardRow[] = baseRows.map((r) => {
        const ex = extras[r.shard_id] ?? {};
        return {
          shard_id: r.shard_id,
          role: r.role,
          memory_used: r.memory_used,
          key_count: numOrNull(r.extras.key_count ?? ex.key_count),
          write_ops_per_sec: numOrNull(r.extras.write_ops_per_sec ?? ex.write_ops_per_sec),
          index_lag: numOrNull(r.extras.index_lag ?? ex.index_lag),
          last_observed_at: capturedAtRaw,
          snapshot_age_seconds: ageSec,
        };
      });

      // No master rows extracted from a fresh envelope → fall back to the
      // degraded shape so the caller always gets a renderable response.
      if (rows.length === 0) {
        return [await buildDegradedPerShardRow(redis, capturedAtRaw, ageSec)];
      }
      return rows;
    } catch (err) {
      const translated = translateObservabilityRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });

  // Wave 5.57 — historical points for the Cluster snapshot sparklines /
  // popout modal. TimeSeries-first; UI falls back to a client-side ring
  // buffer when source === "unavailable".
  app.get<{ Querystring: { metric?: string; windowMs?: string } }>(
    "/observability/history",
    { config: { category: "light" } },
    async (req, reply) => {
      const metricRaw = String(req.query.metric ?? "");
      const target_label = getActiveTarget().label;
      const windowMs = (() => {
        const n = Number(req.query.windowMs ?? RETENTION_MS);
        return Number.isFinite(n) && n > 0 ? Math.min(n, RETENTION_MS) : RETENTION_MS;
      })();
      if (!isValidMetric(metricRaw)) {
        reply.code(400);
        return { error: "invalid metric", target_label };
      }
      const result = await readHistory(await getRedis(req.poolCategory), metricRaw, windowMs, target_label);
      return {
        source: result.source,
        metric: metricRaw,
        windowMs,
        points: result.points,
        reason: result.reason,
        target_label,
      };
    },
  );

  // SSE: write one frame immediately, then every `sseIntervalMs` until the
  // client disconnects. We hijack the reply so Fastify doesn't try to send a
  // JSON body around it.
  app.get("/observability/shards/stream", { config: { category: "light" } }, async (req, reply) => {
    const cors = corsHeadersForRequest(req, corsAllowed);
    reply.raw.writeHead(200, {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.hijack();
    let stopped = false;
    const send = async (): Promise<void> => {
      if (stopped) return;
      try {
        // Re-resolve per tick so an in-flight stream retargets on profile switch.
        const shards = await readShards(await getRedis(req.poolCategory), req.log);
        reply.raw.write(`data: ${JSON.stringify(shards)}\n\n`);
      } catch {
        // Swallow transient errors; the next tick may recover.
      }
    };
    await send();
    const interval = setInterval(send, sseIntervalMs);
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      try { reply.raw.end(); } catch { /* socket already closed */ }
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
