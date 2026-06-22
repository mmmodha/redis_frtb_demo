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

import { createRedisClient, resolveRedisTarget } from "@frtb/redis-client";
import { createServer } from "./server.ts";
import { createWorkerPool, type PoolClient } from "./pool.ts";

const HOST = process.env.BULK_LOADER_HOST ?? process.env.HOST ?? "0.0.0.0";
const PORT = Number(
  process.env.BULK_LOADER_PORT ?? process.env.PORT ?? process.env.HEALTH_PORT ?? 8086,
);
const POOL_SIZE = Number(process.env.BULK_LOADER_POOL_SIZE ?? 32);
const API_BASE = process.env.API_BASE ?? `http://localhost:${process.env.API_PORT ?? 8080}`;

function log(level: "info" | "warn" | "error", msg: string, extra: object = {}): void {
  const line = JSON.stringify({ service: "bulk-loader", level, msg, ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
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

  const pool = createWorkerPool({
    size: POOL_SIZE,
    redisFactory: (workerId) => {
      // Wave 7.0.1.A — non-cluster client per worker. ioredis default retry
      // strategy stays enabled so dropped connections reconnect on their own.
      const client = createRedisClient({ url: resolved.url, cluster: false }) as unknown as PoolClient;
      client.on("ready", () => log("info", "worker ready", { worker_id: workerId }));
      return client;
    },
    logger: { info: (obj, m) => log("info", m, obj) },
  });

  const app = await createServer({ pool, logger: false });
  await app.listen({ host: HOST, port: PORT });
  log("info", "bulk-loader listening", { port: PORT, pool_size: POOL_SIZE });

  if (process.env.SMOKE === "1") {
    await app.close();
    await pool.stop();
    process.exit(0);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      try { await app.close(); } catch { /* ignore */ }
      try { await pool.stop(); } catch { /* ignore */ }
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log("error", "fatal", { err: String(err) });
  process.exit(1);
});
