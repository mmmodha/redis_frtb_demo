// Active-target watcher for the ingest service (Wave 5.55).
//
// Polls the api's /internal/redis/active-target/full endpoint on a fixed
// cadence and rebuilds the ioredis client whenever the api reports a new
// `version`. Unlike source's watcher this one also carries an
// `onTargetChange` callback so cli.ts can drain the in-flight XREADGROUP
// loop on the *old* client before the watcher disconnects it and resume the
// loop against the *new* one. NEVER log the bearer token or the password.

import { Redis } from "ioredis";
import type { RedisLike } from "./consumer.ts";

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

export interface SwapContext {
  client: RedisLike;
  target: ActiveTargetFull;
}

export interface WatcherOpts {
  apiBase: string;
  token: string;
  pollMs?: number;
  initialTimeoutMs?: number;
  initialRetryMs?: number;
  fetchImpl?: typeof fetch;
  redisFactory?: (t: ActiveTargetFull) => RedisLike;
  fallbackUrl?: string;
  // Drains work on prev.client (if any) and resumes against next.client.
  // The watcher disconnects prev.client only after this callback resolves,
  // which gives the consumer loop a clean shutdown window.
  onTargetChange?: (next: SwapContext, prev: SwapContext | null) => Promise<void>;
  logger?: WatcherLogger;
}

export interface ActiveTargetWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getRedis(): RedisLike;
  getCurrent(): ActiveTargetFull;
}

function defaultRedisFactory(t: ActiveTargetFull): RedisLike {
  return new Redis({
    host: t.host,
    port: t.port,
    db: t.db,
    tls: t.tls ? {} : undefined,
    password: t.password,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  }) as unknown as RedisLike;
}

const defaultLogger: WatcherLogger = {
  info: (msg) => console.log(JSON.stringify({ service: "ingest", msg })),
  warn: (msg, err) =>
    console.warn(JSON.stringify({ service: "ingest", level: "warn", msg, err: err ? String(err) : undefined })),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Exponential backoff capped at 30s — matches the spec's "1s, 2s, 4s, 8s
// capped at 30s" sequence when called with base=1000.
function backoffMs(attempt: number, baseMs: number): number {
  const v = baseMs * Math.pow(2, attempt);
  return Math.min(v, 30_000);
}

export function createActiveTargetWatcher(opts: WatcherOpts): ActiveTargetWatcher {
  const pollMs = opts.pollMs ?? 2_500;
  const initialTimeoutMs = opts.initialTimeoutMs ?? 30_000;
  const initialRetryMs = opts.initialRetryMs ?? 1_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const redisFactory = opts.redisFactory ?? defaultRedisFactory;
  const logger = opts.logger ?? defaultLogger;
  const onTargetChange = opts.onTargetChange;

  let current: RedisLike | null = null;
  let currentTarget: ActiveTargetFull | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let swapping = false;

  async function fetchTarget(): Promise<ActiveTargetFull> {
    const url = `${opts.apiBase}/internal/redis/active-target/full`;
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.token}` } });
    if (!r.ok) throw new Error(`api ${r.status}`);
    return (await r.json()) as ActiveTargetFull;
  }

  async function swapTo(t: ActiveTargetFull): Promise<void> {
    if (currentTarget && t.version === currentTarget.version) return;
    if (swapping) return;
    swapping = true;
    try {
      const next = redisFactory(t);
      const prevClient = current;
      const prevTarget = currentTarget;
      current = next;
      currentTarget = t;
      logger.info(JSON.stringify({
        service: "ingest",
        action: "target-switch",
        from: prevTarget?.label ?? null,
        to: t.label,
      }));
      if (onTargetChange) {
        try {
          await onTargetChange(
            { client: next, target: t },
            prevClient && prevTarget ? { client: prevClient, target: prevTarget } : null,
          );
        } catch (err) {
          logger.warn("onTargetChange callback failed", err);
        }
      }
      if (prevClient) {
        try { (prevClient as unknown as { disconnect: () => void }).disconnect(); } catch { /* ignore */ }
      }
    } finally {
      swapping = false;
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
    let attempt = 0;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const t = await fetchTarget();
        await swapTo(t);
        startPolling();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(backoffMs(attempt, initialRetryMs));
        attempt += 1;
      }
    }
    if (opts.fallbackUrl) {
      const client = new Redis(opts.fallbackUrl, { lazyConnect: true, maxRetriesPerRequest: 3 }) as unknown as RedisLike;
      const fallbackTarget: ActiveTargetFull = {
        host: "fallback", port: 0, tls: false, db: 0, label: "REDIS_URL", version: -1,
      };
      current = client;
      currentTarget = fallbackTarget;
      logger.warn("active target: fallback REDIS_URL (api unreachable)", lastErr);
      if (onTargetChange) {
        try { await onTargetChange({ client, target: fallbackTarget }, null); }
        catch (err) { logger.warn("onTargetChange callback failed", err); }
      }
      startPolling();
      return;
    }
    throw new Error(`active-target watcher: api unreachable after ${initialTimeoutMs}ms (${String(lastErr)})`);
  }

  async function stop(): Promise<void> {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (current) {
      try { (current as unknown as { disconnect: () => void }).disconnect(); } catch { /* ignore */ }
    }
    current = null;
    currentTarget = null;
  }

  function getRedis(): RedisLike {
    if (!current) throw new Error("active-target watcher: getRedis() called before start() resolved");
    return current;
  }

  function getCurrent(): ActiveTargetFull {
    if (!currentTarget) throw new Error("active-target watcher: getCurrent() called before start() resolved");
    return currentTarget;
  }

  return { start, stop, pollOnce, getRedis, getCurrent };
}
