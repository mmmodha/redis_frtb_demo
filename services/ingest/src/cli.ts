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
import { createConsumer, ensureGroup, type ConsumerRunner, type RedisLike } from "./consumer.js";
import { createActiveTargetWatcher, type ActiveTargetWatcher } from "./active-target-watcher.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const STREAM = process.env.STREAM_KEY ?? "sensitivities:in";
const GROUP = process.env.CONSUMER_GROUP ?? "ingest";
const CONSUMER_NAME = process.env.CONSUMER_NAME ?? `ingest-${os.hostname()}-${process.pid}`;
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "500");
const BLOCK_MS = Number(process.env.BLOCK_MS ?? "1000");
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
      res.writeHead(state.ready ? 200 : 503, { "content-type": "application/json" });
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

  // Mutable runner reference — rebuilt on every target swap so the
  // throughput log and shutdown hook always observe the live consumer.
  let runner: ConsumerRunner | null = null;
  let activeClient: RedisLike | null = null;
  const state = {
    ready: false,
    consumed: () => runner?.stats.consumed ?? 0,
    errors: () => runner?.stats.errors ?? 0,
  };
  const health = startHealth(HEALTH_PORT, HEALTH_HOST, state);

  let watcher: ActiveTargetWatcher | null = null;

  if (useWatcher) {
    log.info({ apiUrl, pollMs: ACTIVE_TARGET_POLL_MS }, "ingest starting with active-target watcher");
    watcher = createActiveTargetWatcher({
      apiBase: apiUrl!,
      token: internalToken!,
      pollMs: ACTIVE_TARGET_POLL_MS,
      fallbackUrl: redisUrl,
      onTargetChange: async (next, prev) => {
        // Drain the previous consumer so its in-flight XREADGROUP batch
        // finishes (capped by BLOCK_MS) before we tear the old client down.
        if (runner && prev) {
          try { await runner.stop(); } catch (err) {
            log.warn({ err: String(err) }, "drain previous consumer failed");
          }
        }
        await ensureGroup(next.client, STREAM, GROUP);
        runner = createConsumer(next.client, {
          stream: STREAM, group: GROUP, consumerName: CONSUMER_NAME,
          batchSize: BATCH_SIZE, blockMs: BLOCK_MS, schema,
        });
        activeClient = next.client;
        runner.start();
        state.ready = true;
      },
    });
    await watcher.start();
  } else if (redisUrl) {
    log.info({ stream: STREAM, group: GROUP, consumerName: CONSUMER_NAME, source: "REDIS_URL" }, "ingest starting");
    const client = createClientFromUrl(redisUrl);
    activeClient = client;
    await ensureGroup(client, STREAM, GROUP);
    runner = createConsumer(client, {
      stream: STREAM, group: GROUP, consumerName: CONSUMER_NAME,
      batchSize: BATCH_SIZE, blockMs: BLOCK_MS, schema,
    });
    runner.start();
    state.ready = true;
  } else {
    throw new Error("ingest requires REDIS_URL (tests) or API_URL+INTERNAL_API_TOKEN (compose) to locate Redis");
  }

  // Throughput log every 5s
  let last = runner?.stats.consumed ?? 0;
  const tick = setInterval(() => {
    const now = runner?.stats.consumed ?? 0;
    const rps = Math.round((now - last) / 5);
    last = now;
    log.info({ consumed: now, errors: runner?.stats.errors ?? 0, rps }, "ingest progress");
  }, 5000).unref();

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    clearInterval(tick);
    state.ready = false;
    if (runner) await runner.stop();
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
