// Wave 6.39.F — one-shot Redis target resolver for CLI tools (e.g. generator).
//
// Long-running services (source, ingest, loadgen) poll the api's
// /internal/redis/active-target/full endpoint via per-service watchers. A
// one-shot CLI doesn't need polling, but it MUST still honour the api's
// current active target so the UI "active connection" widget reflects where
// the data actually lands. This resolver performs a single fetch and returns
// a redis URL with a 4-tier precedence (highest → lowest):
//
//   1. Explicit URL (e.g. `--redis-url` CLI flag) — operator escape hatch.
//   2. Live active-target from `GET ${apiBase}/internal/redis/active-target/full`
//      (requires bearer token; skipped if apiBase or token are unset).
//   3. `envRedisUrl` (typically `process.env.REDIS_URL` — bootstrap fallback).
//   4. Hard error with a clear message.
//
// Secrets-safety: the resolved URL embeds the active-target password when
// present, so callers MUST NEVER log the URL. The logger emits host/port only.

export interface ActiveTargetFull {
  host: string;
  port: number;
  tls: boolean;
  db: number;
  password?: string;
  label: string;
  version: number;
}

export type ResolvedRedisSource = "explicit" | "active-target" | "env";

export interface ResolvedRedisTarget {
  url: string;
  source: ResolvedRedisSource;
  host: string;
  port: number;
}

export interface ResolverLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface ResolveRedisTargetOptions {
  explicitUrl?: string | undefined;
  apiBase?: string | undefined;
  token?: string | undefined;
  envRedisUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  logger?: ResolverLogger;
  timeoutMs?: number;
}

function hostFromUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : 6379;
    return { host: u.hostname || "redis", port };
  } catch {
    return { host: "redis", port: 0 };
  }
}

// Build a redis:// URL from the active-target descriptor. Password (if any)
// is embedded so callers can hand the URL straight to ioredis; the URL must
// never be echoed into logs (see file header).
export function buildRedisUrlFromTarget(t: ActiveTargetFull): string {
  const scheme = t.tls ? "rediss" : "redis";
  const auth = t.password ? `:${encodeURIComponent(t.password)}@` : "";
  const db = Number.isFinite(t.db) ? t.db : 0;
  return `${scheme}://${auth}${t.host}:${t.port}/${db}`;
}

async function fetchActiveTarget(
  apiBase: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ActiveTargetFull> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof (timer as NodeJS.Timeout).unref === "function") (timer as NodeJS.Timeout).unref();
  try {
    const url = `${apiBase}/internal/redis/active-target/full`;
    const r = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`api ${r.status}`);
    return (await r.json()) as ActiveTargetFull;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveRedisTarget(
  opts: ResolveRedisTargetOptions,
): Promise<ResolvedRedisTarget> {
  const logger = opts.logger;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2000;

  // Tier 1 — explicit flag wins.
  if (opts.explicitUrl) {
    const { host, port } = hostFromUrl(opts.explicitUrl);
    logger?.info({ source: "explicit", host, port }, "redis target resolved");
    return { url: opts.explicitUrl, source: "explicit", host, port };
  }

  // Tier 2 — live active-target. Only attempted when both apiBase and token
  // are configured; otherwise the tier is silently skipped (CI/unit tests).
  if (opts.apiBase && opts.token) {
    try {
      const target = await fetchActiveTarget(opts.apiBase, opts.token, fetchImpl, timeoutMs);
      const url = buildRedisUrlFromTarget(target);
      logger?.info(
        { source: "active-target", host: target.host, port: target.port, label: target.label, version: target.version },
        "redis target resolved",
      );
      return { url, source: "active-target", host: target.host, port: target.port };
    } catch (err) {
      logger?.warn(
        { err: String(err), apiBase: opts.apiBase },
        "active-target fetch failed; falling back to REDIS_URL env",
      );
    }
  }

  // Tier 3 — bootstrap fallback from env.
  if (opts.envRedisUrl) {
    const { host, port } = hostFromUrl(opts.envRedisUrl);
    logger?.info({ source: "env", host, port }, "redis target resolved");
    return { url: opts.envRedisUrl, source: "env", host, port };
  }

  // Tier 4 — hard error.
  throw new Error(
    "redis target missing: pass --redis-url, or set API_URL + INTERNAL_API_TOKEN " +
    "so the api's /internal/redis/active-target/full endpoint can be consulted, " +
    "or set REDIS_URL as a bootstrap fallback.",
  );
}
