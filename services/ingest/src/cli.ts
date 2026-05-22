#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import { Redis, Cluster } from "ioredis";
import pino from "pino";
import { createConsumer, ensureGroup, type RedisLike } from "./consumer.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const STREAM = process.env.STREAM_KEY ?? "sensitivities:in";
const GROUP = process.env.CONSUMER_GROUP ?? "ingest";
const CONSUMER_NAME = process.env.CONSUMER_NAME ?? `ingest-${os.hostname()}-${process.pid}`;
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "500");
const BLOCK_MS = Number(process.env.BLOCK_MS ?? "1000");
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "8083");

interface ActiveTarget {
  host: string;
  port: number;
  password?: string;
  tls?: boolean;
  db?: number;
  url?: string;
}

async function fetchActiveTarget(apiUrl: string): Promise<ActiveTarget> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/redis/active-target`);
  if (!res.ok) throw new Error(`active-target ${res.status}: ${await res.text()}`);
  return (await res.json()) as ActiveTarget;
}

function createClient(target: ActiveTarget | string): RedisLike {
  if (typeof target === "string") {
    if (target.startsWith("redis-cluster://")) {
      return new Cluster([target.replace("redis-cluster://", "redis://")]);
    }
    return new Redis(target);
  }
  if (target.url) return new Redis(target.url);
  return new Redis({
    host: target.host,
    port: target.port,
    password: target.password,
    db: target.db ?? 0,
    tls: target.tls ? {} : undefined,
  });
}

function startHealth(port: number, state: { ready: boolean; consumed: () => number; errors: () => number }): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(state.ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "ingest", status: state.ready ? "ok" : "starting", consumed: state.consumed(), errors: state.errors() }));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, () => {
    log.info({ port }, "ingest healthz listening");
  });
  return server;
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const apiUrl = process.env.API_URL;

  let client: RedisLike;
  if (redisUrl) {
    log.info({ stream: STREAM, group: GROUP, consumerName: CONSUMER_NAME, source: "REDIS_URL" }, "ingest starting");
    client = createClient(redisUrl);
  } else if (apiUrl) {
    log.info({ apiUrl }, "fetching active redis target from api");
    const target = await fetchActiveTarget(apiUrl);
    log.info({ host: target.host, port: target.port, tls: !!target.tls }, "ingest starting against active target");
    client = createClient(target);
  } else {
    throw new Error("ingest requires REDIS_URL (tests) or API_URL (compose) to locate Redis");
  }

  await ensureGroup(client, STREAM, GROUP);
  const runner = createConsumer(client, {
    stream: STREAM, group: GROUP, consumerName: CONSUMER_NAME,
    batchSize: BATCH_SIZE, blockMs: BLOCK_MS,
  });
  const state = { ready: false, consumed: () => runner.stats.consumed, errors: () => runner.stats.errors };
  const health = startHealth(HEALTH_PORT, state);
  runner.start();
  state.ready = true;

  // Throughput log every 5s
  let last = runner.stats.consumed;
  const tick = setInterval(() => {
    const now = runner.stats.consumed;
    const rps = Math.round((now - last) / 5);
    last = now;
    log.info({ consumed: now, errors: runner.stats.errors, rps }, "ingest progress");
  }, 5000).unref();

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    clearInterval(tick);
    state.ready = false;
    await runner.stop();
    await new Promise<void>((r) => health.close(() => r()));
    await (client as Redis).quit().catch(() => undefined);
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
