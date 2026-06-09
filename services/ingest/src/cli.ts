#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Redis, Cluster } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema, type Schema } from "@frtb/schema";
import pino from "pino";
import { type RedisLike } from "./consumer.ts";
import { createActiveTargetWatcher, type ActiveTargetWatcher } from "./active-target-watcher.ts";
import { parseShardAssignment, shardStreamKey } from "./sharding.ts";
import { createMultiShardConsumer, ensureGroupsForShards, type MultiConsumer } from "./multi-consumer.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const STREAM = process.env.STREAM_KEY ?? "sensitivities:in";
const GROUP = process.env.CONSUMER_GROUP ?? "ingest";
const CONSUMER_NAME = process.env.CONSUMER_NAME ?? `ingest-${os.hostname()}-${process.pid}`;
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "500");
const BLOCK_MS = Number(process.env.BLOCK_MS ?? "1000");
// Wave 5.92B — STREAM_SHARDS declares how many input streams the producer
// sprays into (default 1 → bare `sensitivities:in` key, byte-identical to
// pre-5.92). SHARD_ASSIGNMENT picks the subset this replica owns
// (`"all"` / `"0,2,4"` / `"0-3"`). When `STREAM_SHARDS > 1` the consumer
// opens one XREADGROUP loop per assigned shard against `<STREAM>:{<n>}`.
const STREAM_SHARDS = Math.max(1, Number(process.env.STREAM_SHARDS ?? "1"));
const SHARD_ASSIGNMENT_SPEC = process.env.SHARD_ASSIGNMENT ?? "all";
const SHARD_ASSIGNMENT = parseShardAssignment(SHARD_ASSIGNMENT_SPEC, STREAM_SHARDS);
// Wave 5.83B — schema is loaded once at boot from $SCHEMA_FILE so enrichDoc
// can pre-weight every row before JSON.SET. REPO_ROOT resolves relative to
// this file so the default works both under tsx (cwd = services/ingest/)
// and inside the Docker image (file at /app/services/ingest/src/cli.ts).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? join(REPO_ROOT, "config/schema/frtb-default.yaml"),
);
// Wave 5.79: precedence for self-binding is INGEST_HOST/PORT → HOST/PORT
// → HEALTH_PORT → hardcoded default. Lets operators remap or restrict the
// healthz listen address in .env.local without code changes.
const HEALTH_HOST = process.env.INGEST_HOST ?? process.env.HOST ?? "0.0.0.0";
const HEALTH_PORT = Number(process.env.INGEST_PORT ?? process.env.PORT ?? process.env.HEALTH_PORT ?? "8083");
const ACTIVE_TARGET_POLL_MS = Number(process.env.ACTIVE_TARGET_POLL_MS ?? "2500");

function createClientFromUrl(target: string): RedisLike {
  // Wave 5.2: REDIS_URL path → cluster-aware shared helper (honours
  // REDIS_CLUSTER / REDIS_TLS env). Legacy `redis-cluster://` prefix is
  // still supported as an explicit override.
  if (target.startsWith("redis-cluster://")) {
    return new Cluster([target.replace("redis-cluster://", "redis://")]);
  }
  return createRedisClient({ url: target }) as unknown as RedisLike;
}

function startHealth(port: number, host: string, state: { ready: boolean; consumed: () => number; errors: () => number }): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      // Wave 5.97D.1 — liveness only. Always 200 once the process is
      // accepting HTTP so the compose healthcheck passes before Redis is
      // wired, matching the api's /healthz semantics. The body's `status`
      // field still surfaces readiness (`starting` vs `ok`) for callers
      // that inspect it; the HTTP status code is process-alive.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "ingest", status: state.ready ? "ok" : "starting", consumed: state.consumed(), errors: state.errors() }));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, host, () => {
    log.info({ host, port }, "ingest healthz listening");
  });
  return server;
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const apiUrl = process.env.API_URL;
  const internalToken = process.env.INTERNAL_API_TOKEN;

  // Wave 5.83B — load the schema once. enrichDoc needs `risk_weights` and
  // per-class tenor nodes to pre-compute `weighted_value`; a missing schema
  // is fatal because we do not want production runs to silently skip the
  // pre-weighting (the calc fast path would degrade to the Lua fallback).
  let schema: Schema | undefined;
  if (existsSync(SCHEMA_PATH)) {
    try {
      schema = loadSchema(SCHEMA_PATH);
      log.info({ schemaPath: SCHEMA_PATH, classes: Object.keys(schema.risk_classes) }, "ingest schema loaded");
    } catch (err) {
      throw new Error(`failed to load schema ${SCHEMA_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    throw new Error(`schema file not found: ${SCHEMA_PATH} (set SCHEMA_FILE or place config/schema/frtb-default.yaml at repo root)`);
  }

  // Wave 5.55 precedence: API_URL wins so the sidecar tracks the api's
  // active Redis target. REDIS_URL becomes the boot-time fallback. The
  // legacy REDIS_URL-only path (no API_URL) is preserved for CI/unit-tests
  // exactly as before.
  const useWatcher = !!(apiUrl && internalToken);

  // Mutable multi-consumer reference — rebuilt on every target swap so the
  // throughput log and shutdown hook always observe the live runners.
  // With STREAM_SHARDS=1 this holds exactly one ConsumerRunner against the
  // bare `STREAM` key (byte-identical to pre-5.92); with STREAM_SHARDS>1 it
  // holds one runner per assigned shard against `<STREAM>:{<n>}`.
  let multi: MultiConsumer | null = null;
  let activeClient: RedisLike | null = null;
  const state = {
    ready: false,
    consumed: () => multi?.stats.consumed ?? 0,
    errors: () => multi?.stats.errors ?? 0,
  };
  const health = startHealth(HEALTH_PORT, HEALTH_HOST, state);

  // Wave 5.92B — spawn one consumer per assigned shard against the shared
  // ioredis client. Logs one `ingest consumer started` line per shard so
  // `docker compose logs ingest | grep "consumer started"` reflects the
  // actual fan-out.
  async function spawnConsumers(client: RedisLike): Promise<MultiConsumer> {
    const streams = SHARD_ASSIGNMENT.map((s) => shardStreamKey(STREAM, s, STREAM_SHARDS));
    await ensureGroupsForShards(client, streams, GROUP);
    const m = createMultiShardConsumer(client, {
      baseStream: STREAM, group: GROUP, consumerNameBase: CONSUMER_NAME,
      totalShards: STREAM_SHARDS, assignment: SHARD_ASSIGNMENT,
      batchSize: BATCH_SIZE, blockMs: BLOCK_MS, schema,
    });
    m.start();
    for (const h of m.handles) {
      log.info(
        { stream: h.stream, group: GROUP, consumerName: h.consumerName, shard: h.shard, totalShards: STREAM_SHARDS },
        "ingest consumer started",
      );
    }
    return m;
  }

  let watcher: ActiveTargetWatcher | null = null;

  if (SHARD_ASSIGNMENT.length === 0) {
    throw new Error(`SHARD_ASSIGNMENT=${SHARD_ASSIGNMENT_SPEC} resolved to no shards for STREAM_SHARDS=${STREAM_SHARDS}`);
  }

  if (useWatcher) {
    log.info(
      { apiUrl, pollMs: ACTIVE_TARGET_POLL_MS, streamShards: STREAM_SHARDS, shards: SHARD_ASSIGNMENT },
      "ingest starting with active-target watcher",
    );
    watcher = createActiveTargetWatcher({
      apiBase: apiUrl!,
      token: internalToken!,
      pollMs: ACTIVE_TARGET_POLL_MS,
      fallbackUrl: redisUrl,
      onTargetChange: async (next, prev) => {
        // Drain every per-shard runner so each in-flight XREADGROUP batch
        // finishes (capped by BLOCK_MS) before we tear the old client down.
        if (multi && prev) {
          try { await multi.stop(); } catch (err) {
            log.warn({ err: String(err) }, "drain previous consumers failed");
          }
        }
        multi = await spawnConsumers(next.client);
        activeClient = next.client;
        state.ready = true;
      },
    });
    await watcher.start();
  } else if (redisUrl) {
    log.info(
      { stream: STREAM, group: GROUP, consumerName: CONSUMER_NAME, source: "REDIS_URL", streamShards: STREAM_SHARDS, shards: SHARD_ASSIGNMENT },
      "ingest starting",
    );
    const client = createClientFromUrl(redisUrl);
    activeClient = client;
    multi = await spawnConsumers(client);
    state.ready = true;
  } else {
    throw new Error("ingest requires REDIS_URL (tests) or API_URL+INTERNAL_API_TOKEN (compose) to locate Redis");
  }

  // Throughput log every 5s — single roll-up line across all per-shard
  // runners (Wave 5.92B aggregated stats).
  let last = multi?.stats.consumed ?? 0;
  const tick = setInterval(() => {
    const now = multi?.stats.consumed ?? 0;
    const rps = Math.round((now - last) / 5);
    last = now;
    log.info(
      { consumed: now, errors: multi?.stats.errors ?? 0, rps, shards: SHARD_ASSIGNMENT.length },
      "ingest progress",
    );
  }, 5000).unref();

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    clearInterval(tick);
    state.ready = false;
    if (multi) await multi.stop();
    if (watcher) await watcher.stop();
    await new Promise<void>((r) => health.close(() => r()));
    if (activeClient && !watcher) {
      await (activeClient as Redis).quit().catch(() => undefined);
    }
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { void shutdown(sig); });
  }
}

main().catch((err) => {
  log.error({ err: String(err), stack: (err as Error).stack }, "ingest failed");
  process.exit(1);
});
