// FRTB SBM PoV — shared ioredis client factory.
//
// Wave 6.39.E — Enterprise-first default. Redis Enterprise (the production
// target) presents a single proxy endpoint with internal rebalancing across
// shards; clients connect as standalone and the proxy hides the topology,
// blocking `CLUSTER SLOTS` discovery from the outside. Cluster mode is now
// off by default so ioredis does not attempt that discovery on the wrong
// endpoint shape. OSS-cluster operators opt in explicitly via
// `REDIS_CLUSTER=true` (or `createRedisClient({ cluster: true })`).
//
// Secrets-safety: the password is read from the URL and never logged here.
// Callers must never echo the URL or password into logs or commit messages.

import { Cluster, Redis, type ClusterOptions, type RedisOptions } from "ioredis";

// Wave 6.39.F — re-export the one-shot active-target resolver so CLI tools
// (e.g. generator) can honour the api's live active target without copying
// the helper into every package.
export {
  resolveRedisTarget,
  buildRedisUrlFromTarget,
  type ActiveTargetFull,
  type ResolvedRedisTarget,
  type ResolvedRedisSource,
  type ResolverLogger,
  type ResolveRedisTargetOptions,
} from "./active-target-resolver.ts";

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
  // Explicit cluster toggle; falls back to process.env.REDIS_CLUSTER (default false).
  cluster?: boolean;
  // Explicit TLS toggle; falls back to process.env.REDIS_TLS, then to URL scheme.
  tls?: boolean;
  // Forwarded into ioredis options (and redisOptions for cluster mode).
  lazyConnect?: boolean;
  maxRetriesPerRequest?: number | null;
  connectTimeout?: number;
  // Wave 6.18f — per-command timeout override. The factory defaults to
  // 10_000ms (Wave 6.18c boot-protection: ensures the api boot path's
  // bootstrapFrtb() call cannot hang `app.listen(...)`). Callers that issue
  // long-running runtime commands (e.g. FT.AGGREGATE with TIMEOUT 30000)
  // should pass `commandTimeout: 35_000` (30s in-Redis budget + 5s grace)
  // so ioredis does not abort the call before Redis itself returns a clean
  // TIMEOUT error. Use the api's `getActiveRedisRuntimeClient()` when
  // operating inside the api process; this option is the equivalent escape
  // hatch for ingest/generator/loadgen callers that build their own client
  // via `createRedisClient(...)`.
  commandTimeout?: number;
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
  const clusterMode = opts.cluster ?? envBool(process.env.REDIS_CLUSTER, false);
  const tlsEnabled = opts.tls ?? envBool(process.env.REDIS_TLS, parsed.tls);

  const redisOptions: RedisOptions = {
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(tlsEnabled ? { tls: {} } : {}),
    ...(opts.lazyConnect !== undefined ? { lazyConnect: opts.lazyConnect } : {}),
    ...(opts.maxRetriesPerRequest !== undefined ? { maxRetriesPerRequest: opts.maxRetriesPerRequest } : {}),
    // Wave 6.18c — default bounded connect + per-command timeouts so a wedged
    // Redis Enterprise proxy cannot hang the api boot path. Companion to
    // Wave 6.18a's `keepAlive`: keepAlive recovers stalled long-idle sockets,
    // but the very first command on a fresh socket has no probe history yet,
    // so commandTimeout is what catches the boot-time hung-send-q case.
    // Wave 6.18f — `opts.commandTimeout` overrides this default for runtime
    // callers that need to outlast the in-Redis FT_AGGREGATE TIMEOUT (30s).
    // The api's `getActiveRedisRuntimeClient()` is the in-process equivalent.
    connectTimeout: 5_000,
    commandTimeout: 10_000,
    ...(opts.connectTimeout !== undefined ? { connectTimeout: opts.connectTimeout } : {}),
    ...(opts.commandTimeout !== undefined ? { commandTimeout: opts.commandTimeout } : {}),
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
