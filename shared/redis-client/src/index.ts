// FRTB SBM PoV — shared ioredis client factory.
//
// Wave 5.2 target: the user's Redis Enterprise cluster (2 master shards) at
// the seed endpoint embedded in REDIS_URL. Cluster mode is the default
// because the production topology is sharded; explicit REDIS_CLUSTER=false
// drops back to standalone for local/dev fixtures.
//
// Secrets-safety: the password is read from the URL and never logged here.
// Callers must never echo the URL or password into logs or commit messages.

import { Cluster, Redis, type ClusterOptions, type RedisOptions } from "ioredis";

export interface ParsedRedisUrl {
  host: string;
  port: number;
  password?: string;
  username?: string;
  tls: boolean;
  db: number;
}

export interface CreateRedisClientOptions {
  // Explicit URL override; falls back to process.env.REDIS_URL.
  url?: string;
  // Explicit cluster toggle; falls back to process.env.REDIS_CLUSTER (default true).
  cluster?: boolean;
  // Explicit TLS toggle; falls back to process.env.REDIS_TLS, then to URL scheme.
  tls?: boolean;
  // Forwarded into ioredis options (and redisOptions for cluster mode).
  lazyConnect?: boolean;
  maxRetriesPerRequest?: number | null;
  connectTimeout?: number;
}

export function parseRedisUrl(raw: string): ParsedRedisUrl {
  const u = new URL(raw);
  const tls = u.protocol === "rediss:" || u.protocol === "rediss";
  const port = u.port ? Number(u.port) : 6379;
  const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) || 0 : 0;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  const username = u.username ? decodeURIComponent(u.username) : undefined;
  return {
    host: u.hostname || "127.0.0.1",
    port,
    ...(password ? { password } : {}),
    ...(username ? { username } : {}),
    tls,
    db,
  };
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

export function createRedisClient(opts: CreateRedisClientOptions = {}): Redis | Cluster {
  const url = opts.url ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error("createRedisClient: REDIS_URL is required (pass opts.url or set env var)");
  }
  const parsed = parseRedisUrl(url);
  const clusterMode = opts.cluster ?? envBool(process.env.REDIS_CLUSTER, true);
  const tlsEnabled = opts.tls ?? envBool(process.env.REDIS_TLS, parsed.tls);

  const redisOptions: RedisOptions = {
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(tlsEnabled ? { tls: {} } : {}),
    ...(opts.lazyConnect !== undefined ? { lazyConnect: opts.lazyConnect } : {}),
    ...(opts.maxRetriesPerRequest !== undefined ? { maxRetriesPerRequest: opts.maxRetriesPerRequest } : {}),
    ...(opts.connectTimeout !== undefined ? { connectTimeout: opts.connectTimeout } : {}),
    // Wave 6.18a — TCP keepAlive so long-idle sockets on Redis Enterprise
    // proxies don't zombie into MaxRetriesPerRequestError. Inherited by the
    // Cluster path via clusterOptions.redisOptions below.
    keepAlive: 30_000,
  };

  if (clusterMode) {
    const clusterOptions: ClusterOptions = {
      redisOptions,
      // Common Redis Enterprise tweak: short slot refresh so failover is visible quickly.
      slotsRefreshTimeout: 5_000,
    };
    return new Cluster([{ host: parsed.host, port: parsed.port }], clusterOptions);
  }

  return new Redis({
    host: parsed.host,
    port: parsed.port,
    db: parsed.db,
    ...redisOptions,
  });
}
