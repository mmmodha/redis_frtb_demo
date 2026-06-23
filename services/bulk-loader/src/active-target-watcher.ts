// Wave 7.0.6.25 — bulk-loader active-target watcher.
//
// Polls the api's active-target endpoint every 5s; whenever the monotonic
// `version` field changes we treat it as a swap signal and fire the onSwitch
// callback. Supports two modes:
//   1. token provided: polls /internal/redis/active-target/full (password included)
//   2. token empty: polls /admin/active-target-identity (public, no password)
//
// The public-endpoint mode is used when bulk-loader boots with no Redis target
// configured (awaiting_target state). Once user configures via UI, the watcher
// picks it up, fires onSwitch to establish the first connection, and transitions
// to token-gated mode if INTERNAL_API_TOKEN is set.
//
// NEVER log the bearer token or the active-target password.

import type { ActiveTargetFull } from "@frtb/redis-client";
import { fetchActiveTargetIdentity, type ActiveTargetIdentity } from "./active-target-identity.ts";

export interface WatcherLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface WatcherOpts {
  apiBase: string;
  token: string;
  pollMs?: number;
  initialTimeoutMs?: number;
  initialRetryMs?: number;
  fetchImpl?: typeof fetch;
  logger?: WatcherLogger;
  // Fired on every poll where the api-side identity differs from the
  // previously observed one. The first successful poll always fires this
  // with `prev=null` so the bulk-loader can reconcile against any drift
  // that happened during its boot (e.g. operator switched the active
  // target between bulk-loader's resolveRedisTarget call and the watcher's
  // first tick). The callback's promise is awaited; if it throws the
  // error is logged and the next tick retries.
  onSwitch?: (next: ActiveTargetFull, prev: ActiveTargetFull | null) => Promise<void> | void;
  // Fired on every poll (successful or skipped no-op) so the bulk-loader
  // can keep its `api_active_target` snapshot fresh for /load/status. This
  // is separate from `onSwitch` because we want to surface the api's view
  // even when it matches the bound target.
  onPoll?: (next: ActiveTargetFull) => void;
}

export interface ActiveTargetWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getCurrent(): ActiveTargetFull;
}

const defaultLogger: WatcherLogger = {
  info: (obj, msg) => console.log(JSON.stringify({ service: "bulk-loader", msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ service: "bulk-loader", level: "warn", msg, ...obj })),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Strip the password before returning to callers — defence-in-depth against
// accidental log serialisation.
function redact(t: ActiveTargetFull): ActiveTargetFull {
  const { password: _pw, ...rest } = t;
  void _pw;
  return rest as ActiveTargetFull;
}

export function createActiveTargetWatcher(opts: WatcherOpts): ActiveTargetWatcher {
  const pollMs = opts.pollMs ?? 5000;
  const initialTimeoutMs = opts.initialTimeoutMs ?? 30_000;
  const initialRetryMs = opts.initialRetryMs ?? 1_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logger = opts.logger ?? defaultLogger;

  let current: ActiveTargetFull | null = null;
  let currentVersion: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let tickInFlight = false;

  // Wave 7.0.6.25 — fetch from token-gated /internal endpoint when token is
  // provided, otherwise from public /admin/active-target-identity. The public
  // endpoint returns host/port/label/version but NO password/tls/db, so we
  // default those fields to passwordless standalone Redis (tls=false, db=0).
  async function fetchTarget(): Promise<ActiveTargetFull> {
    if (opts.token) {
      const url = `${opts.apiBase}/internal/redis/active-target/full`;
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.token}` } });
      if (!r.ok) throw new Error(`api ${r.status}`);
      return (await r.json()) as ActiveTargetFull;
    } else {
      const identity: ActiveTargetIdentity | null = await fetchActiveTargetIdentity(opts.apiBase);
      if (!identity) throw new Error("public active-target-identity fetch failed");
      // Enrich identity to ActiveTargetFull with default standalone Redis shape.
      return {
        host: identity.host,
        port: identity.port,
        label: identity.label,
        version: identity.version,
        tls: false,
        db: 0,
      };
    }
  }

  async function applySwitch(next: ActiveTargetFull): Promise<void> {
    const prev = current;
    if (next.version === currentVersion) {
      // No identity change — still surface the snapshot via onPoll.
      opts.onPoll?.(redact(next));
      return;
    }
    current = next;
    currentVersion = next.version;
    logger.info(
      { label: next.label, host: next.host, port: next.port, version: next.version },
      "active target observed",
    );
    opts.onPoll?.(redact(next));
    if (opts.onSwitch) {
      try {
        await opts.onSwitch(next, prev);
      } catch (err) {
        logger.warn({ err: String(err) }, "active-target onSwitch handler failed");
      }
    }
  }

  async function pollOnce(): Promise<void> {
    if (tickInFlight) return; // serialise so a slow swap doesn't double-fire
    tickInFlight = true;
    try {
      const t = await fetchTarget();
      await applySwitch(t);
    } catch (err) {
      logger.warn({ err: String(err) }, "active-target poll failed; keeping current target");
    } finally {
      tickInFlight = false;
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
        await applySwitch(t);
        startPolling();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(initialRetryMs);
      }
    }
    // bulk-loader already has a working pool from the boot resolveRedisTarget
    // call — the watcher is purely a follow-the-api signal. If the api is
    // unreachable on startup we keep polling in the background; the boot
    // pool keeps serving until the next successful poll lands.
    logger.warn({ err: String(lastErr) }, "active-target watcher: api unreachable on startup; will keep polling");
    startPolling();
  }

  async function stop(): Promise<void> {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    current = null;
    currentVersion = null;
  }

  function getCurrent(): ActiveTargetFull {
    if (!current) throw new Error("active-target watcher: getCurrent() called before a successful poll");
    return redact(current);
  }

  return { start, stop, pollOnce, getCurrent };
}
