// Active-target watcher (Wave 5.16u).
//
// Polls the api's /internal/redis/active-target/full endpoint every 5s and
// rebuilds the ioredis client whenever the api reports a new `version`. The
// store and ingest pipeline talk to Redis through the RedisLike returned by
// asRedisLike(): every .call() delegates to the *current* client, so an
// in-flight swap never tears callers between hosts. NEVER log the bearer
// token or the password.

import { Redis, Cluster, type RedisOptions } from "ioredis";
import type { RedisLike } from "./store.ts";

// Wave 5.99B — RedisClient is the union returned by the redis factory. Both
// ioredis classes expose the same .call(...) / .ping() / .disconnect() surface
// the watcher uses, so consumers don't need to discriminate.
export type RedisClient = Redis | Cluster;

export interface ActiveTargetFull {
  host: string;
  port: number;
  tls: boolean;
  db: number;
  password?: string;
  label: string;
  version: number;
  // Wave 5.99B — true OSS Redis Cluster (CLUSTER SLOTS / MOVED redirects). When
  // omitted or non-true the watcher uses the single-node client; the cluster
  // branch is strictly opt-in (=== true) so the existing proxy-endpoint /
  // Enterprise-style path stays bit-for-bit identical to what Wave 5.99 shipped.
  clusterMode?: boolean;
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
  redisFactory?: (t: ActiveTargetFull) => RedisClient;
  logger?: WatcherLogger;
}

export type WatcherState = "starting" | "running" | "waiting";

export interface ActiveTargetWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getRedis(): RedisClient;
  asRedisLike(): RedisLike;
  getState(): WatcherState;
}

// Wave 5.99 — central place to build ioredis options. Wave 5.99B extends this
// with a cluster-mode branch (Redis Cluster vs standalone) below; this helper
// itself is unchanged and still produces the single-node options that Wave 5.99
// shipped (callers on the standalone path see no behavioural change).
function buildStandaloneRedisOptions(t: ActiveTargetFull): RedisOptions {
  return {
    host: t.host,
    port: t.port,
    db: t.db,
    tls: t.tls ? {} : undefined,
    password: t.password,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    // Wave 5.99 — bound every connect/command so a half-open socket can never
    // hang /sources forever. If the cloud Redis goes quiet mid-handshake or a
    // queued command stalls behind a dead connection, ioredis rejects with
    // ETIMEDOUT/"Command timed out" and the asRedisLike() retry path below
    // forces a re-poll of the api's active target.
    connectTimeout: 5000,
    commandTimeout: 5000,
  };
}

// Wave 5.99B — defaultRedisFactory branches strictly on `clusterMode === true`.
// No truthy coercion (string "true" must NOT enable cluster mode) and no auto-
// detection: Enterprise/proxy-endpoint users (clusterMode false or omitted)
// keep the exact single-node code path Wave 5.99 shipped. Exported so the
// regression tests can pin both branches.
export function defaultRedisFactory(t: ActiveTargetFull): RedisClient {
  if (t.clusterMode === true) {
    return new Cluster(
      [{ host: t.host, port: t.port }],
      {
        // Wave 5.99B — mirror Wave 5.99's bounded-timeout discipline on the
        // per-node connection options. ioredis Cluster opens one socket per
        // master and these knobs apply to every one of them, so a half-open
        // socket to any node still rejects within 5s instead of hanging.
        redisOptions: {
          db: t.db,
          tls: t.tls ? {} : undefined,
          password: t.password,
          connectTimeout: 5000,
          commandTimeout: 5000,
        },
        lazyConnect: true,
        // Bound the connect handshake the same way the standalone path bounds
        // its initial connect. Cluster falls back to its own default (10s) if
        // omitted; we lower it to keep the swapTo() ping() check inside the
        // watcher's 5s withTimeout wrapper.
        clusterRetryStrategy: (times) => (times > 3 ? null : 200),
      },
    );
  }
  return new Redis(buildStandaloneRedisOptions(t));
}

// Wave 5.99 — classify ioredis failures that mean "this client is wedged or
// the connection is dead, rebuild and retry". We deliberately match by name,
// node error code, and message substring so we cover MaxRetriesPerRequestError,
// commandTimeout rejections, and raw socket errors without depending on
// internal ioredis exports.
function isTransientRedisError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string; code?: string };
  if (e.name === "MaxRetriesPerRequestError") return true;
  const code = e.code ?? "";
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND" || code === "EPIPE") {
    return true;
  }
  const msg = e.message ?? String(err);
  return /timed out|timeout|max retries|connection is closed|stream isn't writeable/i.test(msg);
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

  let current: RedisClient | null = null;
  let currentVersion: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  // Wave 5.98B — surface watcher progress for /healthz body without blocking
  // the http listen call. "starting" until start() resolves; then "running"
  // when a client is in hand or "waiting" if we kept polling without one.
  let started = false;

  // Wave 5.99 — wrapper-level command timeout. ioredis's own `commandTimeout`
  // option turns out to be unreliable when the underlying socket is half-open
  // (the TCP connection is ESTABLISHED but commands neither flush nor receive
  // a reply, and no error event fires). Promise.race-ing every call against a
  // local setTimeout guarantees /sources can never hang forever, regardless
  // of what ioredis's internal state machine is doing. Used by both swapTo's
  // ping and asRedisLike's per-command path.
  const CALL_TIMEOUT_MS = 5000;
  function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`redis ${label} timed out after ${CALL_TIMEOUT_MS}ms`)),
        CALL_TIMEOUT_MS,
      );
      if (typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

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
      await withTimeout("PING", next.ping());
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
      const client = new Redis(opts.fallbackUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        commandTimeout: 5000,
      });
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

  function getRedis(): RedisClient {
    if (!current) throw new Error("active-target watcher: getRedis() called before start() resolved");
    return current;
  }

  function asRedisLike(): RedisLike {
    return {
      async call(cmd: string, ...args: unknown[]) {
        try {
          return await withTimeout(cmd, (getRedis() as unknown as RedisLike).call(cmd, ...args));
        } catch (err) {
          if (!isTransientRedisError(err)) throw err;
          // Wave 5.99 — the current client is wedged (timed out, max retries,
          // closed socket). Force a re-poll so swapTo() can replace it with a
          // fresh client built from the api's latest active target, then retry
          // the command exactly once. A second failure propagates.
          logger.warn(`redis ${cmd} failed; forcing re-poll and retrying once`, err);
          try { await pollOnce(); } catch { /* pollOnce already logs */ }
          return await withTimeout(cmd, (getRedis() as unknown as RedisLike).call(cmd, ...args));
        }
      },
    };
  }

  return { start, stop, pollOnce, getRedis, asRedisLike, getState };
}
