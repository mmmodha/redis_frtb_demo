// Wave 7.0.1.A — bulk-loader entrypoint.
//
// Resolves the active Redis target once at boot (4-tier precedence from
// @frtb/redis-client: explicit url → live api /internal active-target → env
// REDIS_URL → hard error), then opens BULK_LOADER_POOL_SIZE (default 32)
// parallel non-cluster ioredis connections to that proxy endpoint. OSS
// Cluster API is NOT enabled — we connect each client as standalone, and
// proxy_policy=all-master-shards spreads the connections across master
// nodes inside the Enterprise cluster.
//
// Heartbeat-only until Wave 7.0.1.B wires the write path; /load/status
// reports the connection-pool shape so an operator can sanity-check
// (CLIENT LIST on each master node should show ~even spread).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRedisUrlFromTarget,
  createRedisClient,
  resolveRedisTarget,
  type ActiveTargetFull,
} from "@frtb/redis-client";
import { loadSchema, type Schema } from "@frtb/schema";
import { createServer } from "./server.ts";
import { createWorkerPool, type PoolClient, type WorkerPool } from "./pool.ts";
import { createDispatcher, type DispatcherHandle, type WorkerClient } from "./dispatcher.ts";
import {
  createCheckpointer,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  type CheckpointClient,
  type CheckpointRecord,
  type Checkpointer,
} from "./checkpoint.ts";
import { createActiveTargetWatcher, type ActiveTargetWatcher } from "./active-target-watcher.ts";
import {
  createBulkLoaderState,
  swapTarget,
  updateApiActiveTarget,
  type BulkLoaderState,
  type RebuiltRuntime,
} from "./swap-target.ts";

const HOST = process.env.BULK_LOADER_HOST ?? process.env.HOST ?? "0.0.0.0";
const PORT = Number(
  process.env.BULK_LOADER_PORT ?? process.env.PORT ?? process.env.HEALTH_PORT ?? 8086,
);
const POOL_SIZE = Number(process.env.BULK_LOADER_POOL_SIZE ?? 32);
const BATCH_SIZE = Number(process.env.BULK_LOADER_BATCH_SIZE ?? 1000);
const IDLE_FLUSH_MS = Number(process.env.BULK_LOADER_IDLE_FLUSH_MS ?? 50);
const HIGH_WATER_ENV = process.env.BULK_LOADER_HIGH_WATER;
const CHECKPOINT_INTERVAL_MS = Number(
  process.env.BULK_LOADER_CHECKPOINT_INTERVAL_MS ?? DEFAULT_CHECKPOINT_INTERVAL_MS,
);
const API_BASE = process.env.API_BASE ?? `http://localhost:${process.env.API_PORT ?? 8080}`;
// Wave 7.0.6.17 — watcher poll cadence + stale-target safety-net cadence.
// Watcher only runs when INTERNAL_API_TOKEN is set; the stale poll runs
// unconditionally so an unset-token deploy still fails loud rather than
// silently writing to the wrong DB.
const ACTIVE_TARGET_POLL_MS = Number(process.env.ACTIVE_TARGET_POLL_MS ?? 5_000);
const TARGET_STALE_CHECK_INTERVAL_MS = Number(
  process.env.TARGET_STALE_CHECK_INTERVAL_MS ?? 30_000,
);
// Wave 7.0.6.14 — schema location mirrors services/api/src/index.ts so the
// bulk-loader and the api read the same per-class tenor list. Resolved
// relative to this source file so it works both under tsx (cwd=services/
// bulk-loader/) and the Docker image (file at /app/services/bulk-loader/
// src/index.ts → REPO_ROOT = /app). SCHEMA_FILE env overrides for tests.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? join(REPO_ROOT, "config/schema/frtb-default.yaml"),
);

// Wave 7.0.6.14 — build the per-class tenor map injected into the dispatcher
// so each worker can dense-zero-pad sparse per-tenor rows.
//
// The pad set MUST match the slim-index field declaration in
// shared/rqe/src/index.mjs `buildSlimSchemaFields` exactly — only classes the
// slim index treats as per-tenor get `s_<class>_<leg>_<tenor>` fields
// declared in FT.CREATE; every other class is scalar (`s_<class>_<leg>`) and
// must NOT receive per-tenor padding (the index would not declare those
// fields and the calc LOAD would not request them either, but the wasted
// bytes would inflate HASH size and obscure the contract). Mirrors the
// hardcoded `PER_TENOR_CLASSES = ["GIRR"]` in shared/rqe — kept inline
// rather than re-exported to avoid plumbing a JS module into the TS
// service for one constant. If shared/rqe grows the per-tenor list, update
// here in lockstep.
const SLIM_PER_TENOR_CLASSES: readonly string[] = ["GIRR"] as const;

function buildTenorsByClass(schema: Schema): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const cls of SLIM_PER_TENOR_CLASSES) {
    const cfg = schema.risk_classes[cls];
    const nodes = cfg?.tenor?.nodes;
    if (Array.isArray(nodes) && nodes.length > 0) {
      out.set(cls.toUpperCase(), Object.freeze(nodes.slice()));
    }
  }
  return out;
}

function log(level: "info" | "warn" | "error", msg: string, extra: object = {}): void {
  const line = JSON.stringify({ service: "bulk-loader", level, msg, ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Wave 7.0.6.17 — fetch the api's active-target identity (label + version)
// as a one-shot best-effort. Used at boot to seed the state holder's
// bound_target label (resolveRedisTarget only returns host/port/url) and
// by the periodic stale-target safety-net poll. Returns null on any
// failure so the caller can degrade gracefully.
async function fetchActiveTargetBest(
  apiBase: string,
  token: string | undefined,
  timeoutMs = 2_000,
): Promise<ActiveTargetFull | null> {
  if (!token) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const r = await fetch(`${apiBase}/internal/redis/active-target/full`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as ActiveTargetFull;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (!Number.isFinite(POOL_SIZE) || POOL_SIZE < 1) {
    log("error", "BULK_LOADER_POOL_SIZE must be a positive integer", { value: POOL_SIZE });
    process.exit(1);
  }

  const resolved = await resolveRedisTarget({
    apiBase: API_BASE,
    token: process.env.INTERNAL_API_TOKEN,
    envRedisUrl: process.env.REDIS_URL,
    logger: {
      info: (obj, m) => log("info", m, obj),
      warn: (obj, m) => log("warn", m, obj),
    },
  });
  log("info", "redis target resolved", {
    source: resolved.source,
    host: resolved.host,
    port: resolved.port,
    pool_size: POOL_SIZE,
  });

  // Wave 7.0.6.14 — load the active schema to derive per-class tenor lists
  // for writer-side zero-pad. A missing or unreadable schema is non-fatal:
  // the dispatcher just runs without pad and behaviour collapses to pre-7.0.
  // 6.14, so a misconfigured bulk-loader continues to ingest (it just
  // reintroduces the per-tenor calc crash until the schema is restored).
  let tenorsByClass: Map<string, readonly string[]> | undefined;
  if (existsSync(SCHEMA_PATH)) {
    try {
      const schema = loadSchema(SCHEMA_PATH);
      tenorsByClass = buildTenorsByClass(schema);
      log("info", "schema loaded for tenor zero-pad", {
        path: SCHEMA_PATH,
        per_tenor_classes: [...tenorsByClass.keys()],
      });
    } catch (err) {
      log("warn", "schema load failed; writer zero-pad disabled", {
        path: SCHEMA_PATH,
        err: String(err),
      });
    }
  } else {
    log("warn", "schema file not found; writer zero-pad disabled", {
      path: SCHEMA_PATH,
    });
  }

  // Wave 7.0.6.17 — single source of truth for building (pool + dispatcher +
  // checkpointer) against a resolved redis URL. Used both at boot (against
  // resolveRedisTarget output) and during target swaps (against the
  // watcher-supplied ActiveTargetFull). Closes over BATCH_SIZE / HIGH_WATER
  // / tenorsByClass so swapTarget doesn't need to be re-parameterised.
  async function buildRuntime(url: string): Promise<RebuiltRuntime> {
    const pool: WorkerPool = createWorkerPool({
      size: POOL_SIZE,
      redisFactory: (workerId) => {
        // ioredis default retry strategy stays enabled so dropped
        // connections reconnect on their own.
        const client = createRedisClient({ url, cluster: false }) as unknown as PoolClient;
        client.on("ready", () => log("info", "worker ready", { worker_id: workerId }));
        return client;
      },
      logger: { info: (obj, m) => log("info", m, obj) },
    });
    const dispatcher: DispatcherHandle = createDispatcher({
      workerClients: pool.workers.map((w) => w.client as unknown as WorkerClient),
      batchSize: BATCH_SIZE,
      idleFlushMs: IDLE_FLUSH_MS,
      highWater: HIGH_WATER_ENV ? Number(HIGH_WATER_ENV) : undefined,
      logger: {
        warn: (obj, m) => log("warn", m, obj),
        info: (obj, m) => log("info", m, obj),
      },
      tenorsByClass,
    });
    const firstPoolClient = pool.workers[0]?.client as unknown as CheckpointClient | undefined;
    let checkpointer: Checkpointer | null = null;
    let bootstrap: Map<number, CheckpointRecord> = new Map();
    if (firstPoolClient) {
      checkpointer = createCheckpointer({
        client: firstPoolClient,
        source: {
          workers: () =>
            dispatcher.workers.map((w) => {
              const m = w.metrics();
              return { id: m.id, flushed: m.flushed, lastUlid: m.lastUlid };
            }),
        },
        intervalMs: CHECKPOINT_INTERVAL_MS,
        logger: { warn: (obj, m) => log("warn", m, obj) },
      });
      try {
        bootstrap = await checkpointer.loadAll(POOL_SIZE);
        log("info", "bulk-loader checkpoints loaded", {
          count: bootstrap.size,
          interval_ms: CHECKPOINT_INTERVAL_MS,
        });
      } catch (err) {
        log("warn", "bulk-loader checkpoint bootstrap failed", { err: String(err) });
      }
      checkpointer.start();
    }
    return { pool, dispatcher, checkpointer, bootstrapCheckpoints: bootstrap };
  }

  // Boot triple — built against the URL we just resolved.
  const initial = await buildRuntime(resolved.url);

  // Wave 7.0.6.17 — try to fetch the api's labelled identity so the state
  // holder's bound_target.label is populated correctly. Best-effort; on
  // failure we fall back to a synthetic label derived from the resolver
  // source so /load/status still has something printable.
  const token = process.env.INTERNAL_API_TOKEN;
  const apiInitial = await fetchActiveTargetBest(API_BASE, token);
  const boundLabel = apiInitial?.label
    ?? (resolved.source === "active-target" ? "active-target" : resolved.source === "explicit" ? "explicit-url" : "env-redis");
  const state: BulkLoaderState = createBulkLoaderState({
    pool: initial.pool,
    dispatcher: initial.dispatcher,
    checkpointer: initial.checkpointer,
    bootstrapCheckpoints: initial.bootstrapCheckpoints,
    boundTarget: { host: resolved.host, port: resolved.port, label: boundLabel },
    boundVersion: apiInitial?.version ?? null,
    targetWatcher: token ? "enabled" : "disabled",
  });

  // Wave 7.0.6.17 — active-target watcher. When INTERNAL_API_TOKEN is set,
  // poll /internal/redis/active-target/full every 5s and invoke
  // swapTarget on any version bump. The onPoll hook keeps the
  // api_active_target snapshot fresh on /load/status so the UI banner can
  // detect divergence even between version bumps.
  let watcher: ActiveTargetWatcher | null = null;
  if (token) {
    watcher = createActiveTargetWatcher({
      apiBase: API_BASE,
      token,
      pollMs: ACTIVE_TARGET_POLL_MS,
      logger: {
        info: (obj, m) => log("info", m, obj),
        warn: (obj, m) => log("warn", m, obj),
      },
      onPoll: (t) => {
        updateApiActiveTarget(
          state,
          { host: t.host, port: t.port, label: t.label },
          t.version,
        );
      },
      onSwitch: async (next) => {
        const r = await swapTarget(state, next, {
          rebuildFromTarget: async (target) => buildRuntime(buildRedisUrlFromTarget(target)),
          logger: {
            info: (obj, m) => log("info", m, obj),
            warn: (obj, m) => log("warn", m, obj),
            error: (obj, m) => log("error", m, obj),
          },
        });
        if (!r.ok) {
          // swapTarget already set last_swap_error / target_stale; surface
          // the failure here so an operator tailing logs sees the watcher-
          // attributed reason too.
          log("error", "active-target swap rejected", { reason: r.reason });
        }
      },
    });
    void watcher.start();
  } else {
    log("warn", "INTERNAL_API_TOKEN not set; active-target watcher disabled", {});
  }

  // Wave 7.0.6.17 — periodic stale-target safety-net. Even when the
  // watcher is enabled, a swap failure leaves last_swap_error set; this
  // poll keeps updating api_active_target so the UI banner reflects the
  // current divergence and /load/rows fails loud. When the watcher is
  // disabled this is the ONLY signal that flips target_stale=true.
  const staleTimer: NodeJS.Timeout = setInterval(async () => {
    const t = await fetchActiveTargetBest(API_BASE, token);
    if (!t) return;
    updateApiActiveTarget(
      state,
      { host: t.host, port: t.port, label: t.label },
      t.version,
    );
  }, TARGET_STALE_CHECK_INTERVAL_MS);
  if (typeof staleTimer.unref === "function") staleTimer.unref();

  const app = await createServer({
    state,
    logger: false,
    logEvent: (level, obj, m) => log(level, m, obj),
  });
  await app.listen({ host: HOST, port: PORT });
  log("info", "bulk-loader listening", {
    port: PORT,
    pool_size: POOL_SIZE,
    batch_size: BATCH_SIZE,
    idle_flush_ms: IDLE_FLUSH_MS,
    high_water: initial.dispatcher.status().highWater,
    checkpoint_interval_ms: CHECKPOINT_INTERVAL_MS,
    target_watcher: state.targetWatcher,
    bound_label: state.boundTarget.label,
  });

  if (process.env.SMOKE === "1") {
    await app.close();
    if (watcher) await watcher.stop();
    clearInterval(staleTimer);
    if (state.checkpointer) await state.checkpointer.stop();
    if (state.dispatcher) await state.dispatcher.stop();
    await state.pool.stop();
    process.exit(0);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      try { await app.close(); } catch { /* ignore */ }
      try { if (watcher) await watcher.stop(); } catch { /* ignore */ }
      try { clearInterval(staleTimer); } catch { /* ignore */ }
      try { if (state.checkpointer) await state.checkpointer.stop(); } catch { /* ignore */ }
      try { if (state.dispatcher) await state.dispatcher.stop(); } catch { /* ignore */ }
      try { await state.pool.stop(); } catch { /* ignore */ }
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log("error", "fatal", { err: String(err) });
  process.exit(1);
});
