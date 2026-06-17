// Active Redis target singleton.
//
// Other services (ingest, generator, source, calc, loadgen) and our own
// endpoints obtain the current target via `GET /redis/active-target`. The
// Connections store agent (task c496f7e8) will set the active target on
// profile-switch via `setActiveTarget(...)`. With no override, we fall back
// to the REDIS_URL env var, then to localhost — keeping CI / unit tests
// trivially configurable.

import { Redis } from "ioredis";

export interface ActiveTarget {
  host: string;
  port: number;
  tls: boolean;
  db: number;
  label: string;
  // Locked Wave-2 contract addition (router agent): true when target is a
  // multi-shard Redis Enterprise cluster requiring cluster-mode ioredis.
  clusterMode?: boolean;
}

export type ActiveTargetListener = (t: ActiveTarget) => void;

// Wave 5.16y — private credentials accompanying the active target. Kept
// strictly separate from the public ActiveTarget type so `getActiveTarget()`
// (and therefore `GET /redis/active-target`) cannot leak secrets. Only
// `getActiveRedisClient()` reads these to authenticate the ioredis client.
export interface ActiveTargetCreds {
  username?: string;
  password?: string;
}

let override: ActiveTarget | undefined;
let overrideCreds: ActiveTargetCreds = {};
// Monotonic per-set counter folded into the cache key so any setActiveTarget
// call invalidates the cached client — even a credentials-only rotation that
// keeps host/port/db unchanged. Avoids embedding the password itself in the
// cache key string.
let credsGeneration = 0;
const listeners = new Set<ActiveTargetListener>();
let cachedClient: Redis | null = null;
let cachedClientKey = "";

function targetKey(t: ActiveTarget): string {
  return `${t.host}|${t.port}|${t.tls ? 1 : 0}|${t.db}|${t.clusterMode ? 1 : 0}|${credsGeneration}`;
}

// Three kinds of mutation are supported on this singleton:
//   1. Full identity switch — `setActiveTarget(...)`: replaces host/port/tls/db
//      (and creds), bumps `credsGeneration` so the cached ioredis client is
//      rebuilt, and fires listeners (the bootstrap scheduler hangs off this).
//   2. Label-only refresh — `setActiveTargetLabel(...)`: a rename of the
//      currently-active profile. The Redis we're pointed at is unchanged, so we
//      MUST NOT bump `credsGeneration` (would invalidate the cached client for
//      no reason) and MUST NOT fire listeners (would re-trigger bootstrap).
//      Consumers learn the new label via the next `GET /redis/active-target`.
//   3. Creds-only rotation — currently handled by funnelling through
//      `setActiveTarget`. It bumps creds and re-runs bootstrap; acceptable
//      because creds rotations are rare. Documented here so a future split
//      (setActiveTargetCreds) can be added without surprising existing callers.
export function setActiveTarget(t: ActiveTarget, creds?: ActiveTargetCreds): void {
  // Strip any stray fields (notably `password`) — the public type is intentionally
  // password-free; secrets live only in the encrypted Connections store and in
  // the private `overrideCreds` slot below.
  override = {
    host: t.host,
    port: t.port,
    tls: !!t.tls,
    db: t.db ?? 0,
    label: t.label,
    ...(t.clusterMode ? { clusterMode: true } : {}),
  };
  // Wave 5.16y — store creds privately so getActiveRedisClient() can
  // authenticate. Callers that don't pass creds (legacy tests, env-only flow)
  // get an empty record and the client is built without username/password.
  overrideCreds = creds ? { username: creds.username, password: creds.password } : {};
  credsGeneration += 1;
  for (const fn of listeners) {
    try { fn(override); } catch { /* listener errors must not break the setter */ }
  }
}

// Wave 5.62 — label-only refresh for the active-target singleton. The label is
// a presentation field surfaced by `GET /redis/active-target` (consumed by the
// UI pill). Renaming the active profile must update the pill but MUST NOT bump
// `credsGeneration` (no client rebuild needed — same Redis) and MUST NOT fire
// listeners (the bootstrap scheduler subscribes here and would otherwise flip
// the status banner to "Bootstrapping…" on a pure rename). No-op when there's
// no override (e.g. fallback to REDIS_URL): there is no caller-installed label
// to mutate, and the env-derived label is computed on read.
export function setActiveTargetLabel(label: string): void {
  if (!override) return;
  override = { ...override, label };
}

export function resetActiveTarget(): void {
  override = undefined;
  overrideCreds = {};
  if (cachedClient) {
    try { cachedClient.disconnect(); } catch { /* ignore */ }
  }
  cachedClient = null;
  cachedClientKey = "";
}

export function onActiveTargetChange(fn: ActiveTargetListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Returns a lazyConnect ioredis client bound to the current active target.
// Cached and rebuilt when the target identity (host/port/tls/db) OR the
// stored credentials change so callers (router, observability) get a stable
// instance between switches but authenticated targets don't trip NOAUTH.
export function getActiveRedisClient(): Redis | null {
  const t = getActiveTarget();
  const c = overrideCreds;
  const key = targetKey(t);
  if (cachedClient && key === cachedClientKey) return cachedClient;
  if (cachedClient) {
    try { cachedClient.disconnect(); } catch { /* ignore */ }
  }
  cachedClient = new Redis({
    host: t.host,
    port: t.port,
    db: t.db,
    tls: t.tls ? {} : undefined,
    ...(c.username ? { username: c.username } : {}),
    ...(c.password ? { password: c.password } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    // Wave 6.18a — TCP keepAlive so sockets surviving long idle windows on
    // Redis Enterprise proxies do not zombie into MaxRetriesPerRequestError
    // without recovering until the process restarts.
    keepAlive: 30_000,
    // Wave 6.18c — bounded connect + per-command timeouts. The 6.18a
    // keepAlive cannot protect the very first command sent on a fresh
    // socket (no probe interval has elapsed yet). A wedged Redis Enterprise
    // proxy could therefore still hang `bootstrapFrtb()` and prevent
    // `app.listen()` from binding. With these two limits, any hung command
    // fails fast and the boot path completes.
    connectTimeout: 5_000,
    commandTimeout: 10_000,
  });
  cachedClientKey = key;
  return cachedClient;
}

export function getActiveTarget(): ActiveTarget {
  if (override) return override;
  const url = process.env.REDIS_URL;
  if (url) return parseRedisUrl(url);
  return { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "default" };
}

function parseRedisUrl(raw: string): ActiveTarget {
  try {
    const u = new URL(raw);
    const tls = u.protocol === "rediss:" || u.protocol === "rediss";
    const port = u.port ? Number(u.port) : tls ? 6379 : 6379;
    const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) || 0 : 0;
    return { host: u.hostname || "127.0.0.1", port, tls, db, label: "env:REDIS_URL" };
  } catch {
    return { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "env:REDIS_URL" };
  }
}
