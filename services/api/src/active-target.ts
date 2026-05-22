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

let override: ActiveTarget | undefined;
const listeners = new Set<ActiveTargetListener>();
let cachedClient: Redis | null = null;
let cachedClientKey = "";

function targetKey(t: ActiveTarget): string {
  return `${t.host}|${t.port}|${t.tls ? 1 : 0}|${t.db}|${t.clusterMode ? 1 : 0}`;
}

export function setActiveTarget(t: ActiveTarget): void {
  // Strip any stray fields (notably `password`) — the public type is intentionally
  // password-free; secrets live only in the encrypted Connections store.
  override = {
    host: t.host,
    port: t.port,
    tls: !!t.tls,
    db: t.db ?? 0,
    label: t.label,
    ...(t.clusterMode ? { clusterMode: true } : {}),
  };
  for (const fn of listeners) {
    try { fn(override); } catch { /* listener errors must not break the setter */ }
  }
}

export function resetActiveTarget(): void {
  override = undefined;
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
// Cached and rebuilt when the target identity (host/port/tls/db) changes so
// callers (router, observability) get a stable instance between switches.
export function getActiveRedisClient(): Redis | null {
  const t = getActiveTarget();
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
    lazyConnect: true,
    maxRetriesPerRequest: 3,
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
