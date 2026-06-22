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
import { resolveLiveTailMode, type RedisLike } from "./consumer.ts";
import { createActiveTargetWatcher, defaultRedisFactory, type ActiveTargetWatcher } from "./active-target-watcher.ts";
import { parseShardAssignment, shardStreamKey } from "./sharding.ts";
import { createMultiShardConsumer, ensureGroupsForShards } from "./multi-consumer.ts";
import { createShardRuntime, RebuildBusyError, RebuildTimeoutError, type ShardRuntime } from "./shard-runtime.ts";
import { backfillRollups } from "./backfill-rollups.ts";
import { performHaltAndFlush } from "./halt-and-flush.ts";
import { makeAdminActiveTargetHandler } from "./admin-active-target.ts";

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

function startHealth(
  port: number,
  host: string,
  state: { ready: boolean; consumed: () => number; errors: () => number },
  // Wave 6.12a — shard-control routes (/ingest/shards GET+POST, /ingest/status
  // GET) are served alongside /healthz so operators can hit a single port and
  // the api proxy can fan out to one upstream. Optional so unit tests that
  // exercise only /healthz can omit it.
  runtime?: ShardRuntime,
  // Wave 6.44.E — first-chance handler for routes that need access to the
  // live activeClient / token closure (POST /ingest/halt-and-flush). Runs
  // before the runtime's handleRequest so the halt route can preempt; the
  // runtime then keeps owning /ingest/shards + /ingest/status.
  extraHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>,
): http.Server {
  const server = http.createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (extraHandler) {
        const claimed = await extraHandler(req, res);
        if (claimed) return;
      }
      if (runtime && runtime.handleRequest(req, res, { consumed: state.consumed(), errors: state.errors(), ready: state.ready })) {
        return;
      }
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
    };
    void handle().catch((err) => {
      log.error({ err: String(err), url: req.url }, "ingest http handler failed");
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  });
  server.listen(port, host, () => {
    log.info({ host, port }, "ingest healthz listening");
  });
  return server;
}

// Wave 6.44.E — request body reader for the halt-and-flush route. Mirrors
// the helper inside shard-runtime; kept local here so cli.ts isn't coupled
// to the runtime's private body reader.
function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer | string) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// Wave 6.44.E — POST /ingest/halt-and-flush handler. Bearer-token guarded
// by INTERNAL_API_TOKEN (same posture as /ingest/shards inside the api
// proxy). Captures the live activeClient lazily so a target swap that
// completes between the request landing and the handler running still
// flushes against the up-to-date client.
function makeHaltAndFlushHandler(
  shardRuntime: ShardRuntime,
  getActiveClient: () => RedisLike | null,
  internalToken: string | undefined,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const writeJson = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    if (req.url !== "/ingest/halt-and-flush" || req.method !== "POST") return false;
    if (internalToken) {
      const auth = req.headers["authorization"];
      const expected = `Bearer ${internalToken}`;
      if (auth !== expected) { writeJson(res, 401, { ok: false, error: "unauthorized" }); return true; }
    }
    const client = getActiveClient();
    if (!client) { writeJson(res, 503, { ok: false, error: "no active redis client" }); return true; }
    // Body is optional; reading drains it so keep-alive sockets don't stall.
    // Wave 6.53.B — body may carry { clearDocs?: boolean } to flip the
    // destructive SCAN+UNLINK doc-clearing step. Default true preserves
    // the legacy /admin/cancel-all-runs + /admin/flush behaviour; the api
    // proxy's callIngestHaltAndTrim helper posts { clearDocs: false } from
    // /admin/stop-runs so writes halt at the next safe boundary without
    // wiping existing sens:* docs.
    let clearDocs = true;
    try {
      const raw = await readRequestBody(req);
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as { clearDocs?: unknown };
        if (parsed && typeof parsed === "object" && typeof parsed.clearDocs === "boolean") {
          clearDocs = parsed.clearDocs;
        }
      }
    } catch { /* best-effort: malformed body falls back to default */ }
    const t0 = Date.now();
    try {
      const report = await shardRuntime.haltAndFlush(async (snap) => {
        return performHaltAndFlush(client, STREAM, snap.totalShards, { clearDocs });
      });
      writeJson(res, 200, { ok: true, ...report, elapsed_ms: Date.now() - t0 });
    } catch (err) {
      if (err instanceof RebuildBusyError) {
        writeJson(res, 409, { ok: false, error: "rebuild in progress" });
      } else if (err instanceof RebuildTimeoutError) {
        writeJson(res, 504, { ok: false, error: "halt-and-flush timed out", stage: err.stage });
      } else {
        log.error({ err: String(err) }, "halt-and-flush failed");
        writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return true;
  };
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const apiUrl = process.env.API_URL;
  const internalToken = process.env.INTERNAL_API_TOKEN;

  // Wave 7.0.6 — live-tail mode log line. processBatch / processBatchAtomic
  // resolve the same env var per batch, so the actual write-path gating is
  // already in effect; this is purely operator-visible breadcrumb so the
  // boot log makes it obvious whether the consumer is running in sens-only
  // mode or the legacy rollup-and-seen mode.
  if (resolveLiveTailMode(process.env.LIVE_TAIL_MODE)) {
    log.info(
      { liveTailMode: true },
      "ingest LIVE_TAIL_MODE=1 — sens-only writes (rollup/seen/processed/suggester gated off; bulk loader owns those keys post-load)",
    );
  }

  // Wave 6.14c — one-shot rollup backfill. Walks the existing sens:* docs
  // and rebuilds the per-bucket rollup hashes via HSET (idempotent). Runs
  // before schema/consumer wiring so an operator can rebuild rollups on a
  // cluster that may not have a SCHEMA_FILE staged. Exits 0 on success.
  if (process.env.BACKFILL_ROLLUPS === "1") {
    if (!redisUrl) throw new Error("BACKFILL_ROLLUPS=1 requires REDIS_URL");
    const client = createClientFromUrl(redisUrl);
    try {
      const t0 = Date.now();
      const report = await backfillRollups(client);
      log.info({ ...report, elapsed_ms: Date.now() - t0 }, "ingest backfill-rollups done");
    } finally {
      await (client as Redis).quit().catch(() => undefined);
    }
    return;
  }

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

  let activeClient: RedisLike | null = null;
  // Wave 6.15b — factory invoked once per shard runner at spawn time so
  // each runner owns a dedicated ioredis socket for its XREADGROUP /
  // pipeline.exec / XACK hot path. The closure is replaced on every
  // active-target swap so post-swap spawns hit the new target with the
  // exact option shape the watcher uses for its shared activeClient.
  let makeRunnerClient: (() => RedisLike) | null = null;

  // Wave 6.12a — shard config lives in shardRuntime; the active-target
  // watcher's `onTargetChange` and POST /ingest/shards both funnel through
  // `runtime.rebuild()` so a single in-flight mutex serialises the
  // drain+respawn for both flows. The spawn closure captures `activeClient`
  // by reference so a target swap (which updates activeClient just before
  // calling rebuild) makes the next spawn open XREADGROUP against the new
  // client. With STREAM_SHARDS=1 / SHARD_ASSIGNMENT="all" this stays
  // byte-identical to pre-6.12a until a POST mutates the config.
  const shardRuntime = createShardRuntime({
    baseStream: STREAM,
    initialTotalShards: STREAM_SHARDS,
    initialAssignmentSpec: SHARD_ASSIGNMENT_SPEC,
    logger: { warn: (msg, meta) => log.warn(meta ?? {}, msg) },
    spawn: async (totalShards, assignment) => {
      const sharedClient = activeClient;
      const factory = makeRunnerClient;
      if (!sharedClient || !factory) throw new Error("no active redis client");
      // Wave 6.15b — operator-visible soft cap. Each runner opens its own
      // ioredis client (1 socket for standalone; N sockets across masters
      // for Cluster); the *2 factor leaves headroom for the shared
      // activeClient + watcher subscribe socket. The cluster's `maxclients`
      // setting is the hard ceiling — bump this number if your cluster has
      // been provisioned for more concurrent client connections.
      if (totalShards * 2 > 32) {
        log.warn(
          { totalShards, projectedConnections: totalShards * 2, softCap: 32 },
          "ingest: per-runner connection count exceeds soft cap (totalShards*2 > 32); confirm cluster maxclients headroom",
        );
      }
      const streams = assignment.map((s) => shardStreamKey(STREAM, s, totalShards));
      await ensureGroupsForShards(sharedClient, streams, GROUP);
      const m = createMultiShardConsumer(sharedClient, {
        baseStream: STREAM, group: GROUP, consumerNameBase: CONSUMER_NAME,
        totalShards, assignment, batchSize: BATCH_SIZE, blockMs: BLOCK_MS, schema,
        makeRunnerClient: factory,
        // Wave 6.39.G — H1: each consumer tick reports non-NOGROUP errors via
        // pino so a CROSSSLOT-style regression is visible on first occurrence.
        // H2: periodic PEL drain cadence (env-overridable inside createConsumer).
        // Wave 7.0.6.12 — `error` channel surfaces the per-command MULTI /
        // pipeline failure with `{ phase, command, key, args, err }` from
        // processBatchAtomic; pino emits at error severity so log filters
        // pick it up alongside the umbrella tick warn.
        logger: {
          warn: (meta, msg) => log.warn(meta, msg),
          error: (meta, msg) => log.error(meta, msg),
        },
      });
      m.start();
      for (const h of m.handles) {
        log.info(
          { stream: h.stream, group: GROUP, consumerName: h.consumerName, shard: h.shard, totalShards },
          "ingest consumer started",
        );
      }
      return m;
    },
  });

  const state = {
    ready: false,
    consumed: () => shardRuntime.getMulti()?.stats.consumed ?? 0,
    errors: () => shardRuntime.getMulti()?.stats.errors ?? 0,
  };
  // Wave 6.43.B.2 — declared early so the admin handler's commit() closure
  // can capture it; assignment happens in the useWatcher branch below.
  let watcher: ActiveTargetWatcher | null = null;
  const haltHandler = makeHaltAndFlushHandler(shardRuntime, () => activeClient, internalToken);
  // Wave 6.43.B.2 — admin push endpoints for the api switch coordinator.
  // commit() calls pollOnce() so the next swap fires immediately rather than
  // waiting for ACTIVE_TARGET_POLL_MS to elapse.
  const adminActiveTargetHandler = makeAdminActiveTargetHandler({
    internalToken,
    drain: async () => {
      const m = shardRuntime.getMulti();
      if (m) await m.stop();
      shardRuntime.setMulti(null);
    },
    commit: async () => {
      if (watcher) await watcher.pollOnce();
      if (!shardRuntime.getMulti()) await shardRuntime.rebuild();
    },
    logger: {
      warn: (meta, msg) => log.warn(meta, msg),
      error: (meta, msg) => log.error(meta, msg),
    },
  });
  const extraHandler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    if (await haltHandler(req, res)) return true;
    return adminActiveTargetHandler(req, res);
  };
  const health = startHealth(HEALTH_PORT, HEALTH_HOST, state, shardRuntime, extraHandler);

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
      onTargetChange: async (next, _prev) => {
        // Update activeClient first so the spawn closure inside rebuild()
        // opens XREADGROUP against the new client. rebuild() drains the
        // previous multi (still bound to prev.client) before spawning; the
        // watcher disconnects prev.client only after this callback resolves,
        // so the drain window is bounded by max(BLOCK_MS) across runners.
        activeClient = next.client;
        // Wave 6.15b — refresh the per-runner factory so the next spawn
        // builds fresh ioredis clients against the new target with the
        // SAME option shape the watcher uses for its own activeClient.
        const target = next.target;
        makeRunnerClient = () => defaultRedisFactory(target);
        await shardRuntime.rebuild();
        state.ready = true;
      },
    });
    await watcher.start();
  } else if (redisUrl) {
    log.info(
      { stream: STREAM, group: GROUP, consumerName: CONSUMER_NAME, source: "REDIS_URL", streamShards: STREAM_SHARDS, shards: SHARD_ASSIGNMENT },
      "ingest starting",
    );
    activeClient = createClientFromUrl(redisUrl);
    // Wave 6.15b — each shard runner builds its own client from the same
    // URL so the hot path doesn't serialise on the shared activeClient
    // socket. createClientFromUrl honours REDIS_CLUSTER / REDIS_TLS env
    // and the legacy `redis-cluster://` prefix exactly like the shared
    // client above.
    makeRunnerClient = () => createClientFromUrl(redisUrl);
    await shardRuntime.rebuild();
    state.ready = true;
  } else {
    throw new Error("ingest requires REDIS_URL (tests) or API_URL+INTERNAL_API_TOKEN (compose) to locate Redis");
  }

  // Throughput log every 5s — single roll-up line across all per-shard
  // runners (Wave 5.92B aggregated stats). `shards` reflects the live
  // runtime snapshot so a POST /ingest/shards rebuild shows up on the next
  // tick.
  let last = shardRuntime.getMulti()?.stats.consumed ?? 0;
  const tick = setInterval(() => {
    const m = shardRuntime.getMulti();
    const now = m?.stats.consumed ?? 0;
    const rps = Math.round((now - last) / 5);
    last = now;
    log.info(
      { consumed: now, errors: m?.stats.errors ?? 0, rps, shards: shardRuntime.snapshot().assignment.length },
      "ingest progress",
    );
  }, 5000).unref();

  // Wave 6.41.E.fix3 — publish the aggregated consumed counter to Redis at
  // 1Hz so /admin/stream-status (and through it, the IngestPanel indexing
  // bar) can drive its progress off a strictly-monotonic signal instead of
  // xlen. The key is `ingest:consumed:<stream>`; on restart it resets to
  // whatever the new process has consumed since boot — the UI detects that
  // (consumedNow < anchor.consumedAtAnchor) and re-anchors.
  const CONSUMED_KEY = `ingest:consumed:${STREAM}`;
  const publishTick = setInterval(() => {
    const client = activeClient;
    if (!client) return;
    const m = shardRuntime.getMulti();
    const n = m?.stats.consumed ?? 0;
    void (client as { call: (cmd: string, ...args: unknown[]) => Promise<unknown> })
      .call("SET", CONSUMED_KEY, String(n))
      .catch(() => { /* transient redis hiccup — next tick retries */ });
  }, 1000).unref();

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    clearInterval(tick);
    clearInterval(publishTick);
    state.ready = false;
    const m = shardRuntime.getMulti();
    if (m) await m.stop();
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
