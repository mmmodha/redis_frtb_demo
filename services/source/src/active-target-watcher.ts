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

export type WatcherState = "starting" | "running" | "waiting";

export interface ActiveTargetWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getRedis(): Redis;
  asRedisLike(): RedisLike;
  getState(): WatcherState;
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
  // Wave 5.98B — surface watcher progress for /healthz body without blocking
  // the http listen call. "starting" until start() resolves; then "running"
  // when a client is in hand or "waiting" if we kept polling without one.
  let started = false;

  async function fetchTarget(): Promise<ActiveTargetFull> {
    const url = `${opts.apiBase}/internal/redis/active-target/full`;
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.token}` } });
    if (!r.ok) throw new Error(`api ${r.status}`);
    return (await r.json()) as ActiveTargetFull;
  }

  async function swapTo(t: ActiveTargetFull): Promise<void> {
    if (t.version === currentVersion) return;
    const next = redisFactory(t);
    try {
      await next.ping();
    } catch (err) {
      // Wave 5.97D.1 — api reports an active target but Redis itself isn't
      // reachable yet (e.g. MaxRetriesPerRequestError against a placeholder
      // host). Discard the half-built client and keep polling instead of
      // tearing the watcher down. Callers see the previous `current` (or
      // null) until the next swap.
      try { next.disconnect(); } catch { /* ignore */ }
      logger.warn(`active target ${t.label}: not reachable yet (waiting)`, err);
      return;
    }
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
        if (current) {
          started = true;
          startPolling();
          return;
        }
        // swapTo returned without setting `current` (Redis ping failed —
        // treated as "not configured yet"). Loop and retry until the
        // deadline; if we never get a reachable target we still keep
        // polling below so the service stays alive.
      } catch (err) {
        lastErr = err;
      }
      await sleep(initialRetryMs);
    }
    if (opts.fallbackUrl) {
      const client = new Redis(opts.fallbackUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
      try { await client.ping(); } catch { /* future polls may recover */ }
      current = client;
      currentVersion = -1;
      logger.warn("active target: fallback REDIS_URL (api unreachable)", lastErr);
      started = true;
      startPolling();
      return;
    }
    // Wave 5.97D.1 — deadline reached with no reachable target. Stay alive
    // (the source service still answers /healthz) and keep polling so an
    // operator can wire Redis via the UI Connections panel without
    // restarting source. Previously this threw, killing the process.
    logger.warn(
      `active-target watcher: no active target after ${initialTimeoutMs}ms; continuing to poll (${String(lastErr)})`,
    );
    started = true;
    startPolling();
  }

  async function stop(): Promise<void> {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (current) { try { current.disconnect(); } catch { /* ignore */ } }
    current = null;
    currentVersion = null;
    started = false;
  }

  function getState(): WatcherState {
    if (current) return "running";
    if (started) return "waiting";
    return "starting";
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

  return { start, stop, pollOnce, getRedis, asRedisLike, getState };
}
