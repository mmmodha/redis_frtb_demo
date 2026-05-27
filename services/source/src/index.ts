// FRTB SBM PoV — source service entry point.
//
// Spins up the Fastify app against the api service's active-target Redis
// (queried at startup; falls back to env). The source service intentionally
// shares a single Redis client (per redis-development conn-pooling rule);
// streams writes are pipelined inside ingestFile().

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Cluster, Redis } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema } from "@frtb/schema";
import { createServer } from "./server.ts";
import { createSourceStore } from "./store.ts";

const PORT = Number(process.env.PORT ?? process.env.HEALTH_PORT ?? 8082);
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? "/app/config/schema/frtb-default.yaml",
);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/data/uploads";
const API_BASE = process.env.API_BASE ?? "http://api:8080";
const REDIS_HOST_ENV = process.env.REDIS_HOST;
const REDIS_PORT_ENV = process.env.REDIS_PORT;

interface ActiveTarget { host: string; port: number; db?: number; tls?: boolean }

async function resolveTarget(): Promise<ActiveTarget> {
  if (REDIS_HOST_ENV) {
    return { host: REDIS_HOST_ENV, port: Number(REDIS_PORT_ENV ?? 6379) };
  }
  try {
    const r = await fetch(`${API_BASE}/redis/active-target`);
    if (!r.ok) throw new Error(`api responded ${r.status}`);
    return (await r.json()) as ActiveTarget;
  } catch {
    return { host: "localhost", port: 6379 };
  }
}

async function main(): Promise<void> {
  // Wave 5.2: prefer REDIS_URL when set (cluster-aware via shared helper).
  // Otherwise fall back to the api's active-target host/port for compose
  // setups where the api owns the connection registry.
  let redis: Redis | Cluster;
  if (process.env.REDIS_URL) {
    redis = createRedisClient({ lazyConnect: true, maxRetriesPerRequest: 3 });
  } else {
    const target = await resolveTarget();
    const { Redis: RedisCtor } = await import("ioredis");
    redis = new RedisCtor({
      host: target.host,
      port: target.port,
      db: target.db ?? 0,
      tls: target.tls ? {} : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }
  try { await redis.connect(); } catch (err) {
    console.log(JSON.stringify({ service: "source", status: "redis-unreachable", err: String(err) }));
  }

  const schema = existsSync(SCHEMA_PATH) ? loadSchema(SCHEMA_PATH) : null;
  if (!schema) {
    console.error(JSON.stringify({ service: "source", status: "fatal", err: `schema not found at ${SCHEMA_PATH}` }));
    process.exit(1);
  }

  const store = createSourceStore({ redis });
  const app = await createServer({ redis, store, schema, uploadDir: UPLOAD_DIR, logger: true });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(JSON.stringify({ service: "source", status: "ready", port: PORT }));

  if (process.env.SMOKE === "1") {
    await app.close();
    await redis.quit().catch(() => undefined);
    process.exit(0);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await app.close();
      await redis.quit().catch(() => undefined);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ service: "source", status: "fatal", err: String(err) }));
  process.exit(1);
});
