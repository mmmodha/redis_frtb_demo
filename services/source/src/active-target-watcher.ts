// Active-target watcher (Wave 5.16u).
//
// Polls the api's /internal/redis/active-target/full endpoint every 5s and
// rebuilds the ioredis client whenever the api reports a new `version`. The
// store and ingest pipeline talk to Redis through the RedisLike returned by
// asRedisLike(): every .call() delegates to the *current* client, so an
// in-flight swap never tears callers between hosts. NEVER log the bearer
// token or the password.

import { Redis } from "ioredis";
import type { RedisLike } from "./store.ts";

export interface ActiveTargetFull {
  host: string;
  port: number;
  tls: boolean;
  db: number;
  password?: string;
  label: string;
  version: number;
}

export interface WatcherLogger {
  info(msg: string): void;
  warn(msg: string, err?: unknown): void;
}

export interface WatcherOpts {
  apiBase: string;
  token: string;
  pollMs?: number;
  fallbackUrl?: string;
  initialTimeoutMs?: number;
  initialRetryMs?: number;
  fetchImpl?: typeof fetch;
  redisFactory?: (t: ActiveTargetFull) => Redis;
  logger?: WatcherLogger;
}

export interface ActiveTargetWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getRedis(): Redis;
  asRedisLike(): RedisLike;
}

function defaultRedisFactory(t: ActiveTargetFull): Redis {
  return new Redis({
    host: t.host,
    port: t.port,
    db: t.db,
    tls: t.tls ? {} : undefined,
    password: t.password,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
}

const defaultLogger: WatcherLogger = {
  info: (msg) => console.log(JSON.stringify({ service: "source", msg })),
  warn: (msg, err) =>
    console.warn(JSON.stringify({ service: "source", level: "warn", msg, err: err ? String(err) : undefined })),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createActiveTargetWatcher(opts: WatcherOpts): ActiveTargetWatcher {
  const pollMs = opts.pollMs ?? 5000;
  const initialTimeoutMs = opts.initialTimeoutMs ?? 30_000;
  const initialRetryMs = opts.initialRetryMs ?? 1_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const redisFactory = opts.redisFactory ?? defaultRedisFactory;
  const logger = opts.logger ?? defaultLogger;

  let current: Redis | null = null;
  let currentVersion: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  async function fetchTarget(): Promise<ActiveTargetFull> {
    const url = `${opts.apiBase}/internal/redis/active-target/full`;
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.token}` } });
    if (!r.ok) throw new Error(`api ${r.status}`);
    return (await r.json()) as ActiveTargetFull;
  }

  async function swapTo(t: ActiveTargetFull): Promise<void> {
    if (t.version === currentVersion) return;
    const next = redisFactory(t);
    await next.ping();
    const prev = current;
    current = next;
    currentVersion = t.version;
    logger.info(`active target: ${t.label}`);
    if (prev) {
      try { prev.disconnect(); } catch { /* ignore */ }
    }
  }

  async function pollOnce(): Promise<void> {
    try {
      const t = await fetchTarget();
      await swapTo(t);
    } catch (err) {
      logger.warn("active-target poll failed; keeping current client", err);
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => { void pollOnce(); }, pollMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  async function start(): Promise<void> {
    const deadline = Date.now() + initialTimeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const t = await fetchTarget();
        await swapTo(t);
        startPolling();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(initialRetryMs);
      }
    }
    if (opts.fallbackUrl) {
      const client = new Redis(opts.fallbackUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
      try { await client.ping(); } catch { /* future polls may recover */ }
      current = client;
      currentVersion = -1;
      logger.warn("active target: fallback REDIS_URL (api unreachable)", lastErr);
      startPolling();
      return;
    }
    throw new Error(`active-target watcher: api unreachable after ${initialTimeoutMs}ms (${String(lastErr)})`);
  }

  async function stop(): Promise<void> {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (current) { try { current.disconnect(); } catch { /* ignore */ } }
    current = null;
    currentVersion = null;
  }

  function getRedis(): Redis {
    if (!current) throw new Error("active-target watcher: getRedis() called before start() resolved");
    return current;
  }

  function asRedisLike(): RedisLike {
    return {
      call: (cmd: string, ...args: unknown[]) =>
        (getRedis() as unknown as RedisLike).call(cmd, ...args),
    };
  }

  return { start, stop, pollOnce, getRedis, asRedisLike };
}
