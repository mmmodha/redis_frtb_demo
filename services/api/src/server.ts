import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import type { RedisLike } from "./redis-like.ts";
import type { CorrelationSpec } from "./sbm/reduce.ts";
import { getActiveTarget, setActiveTarget, type ActiveTarget } from "./active-target.ts";
import { registerPivotRoute } from "./routes/pivot.ts";
import { registerCalcRoute } from "./routes/calc.ts";
import { registerObservabilityRoutes } from "./routes/observability.ts";
import { registerSourcesProxyRoutes } from "./routes/sources-proxy.ts";
import { registerLoadgenProxyRoutes } from "./routes/loadgen-proxy.ts";

// Wave 5.14b.1 — bootstrap-status flag. Compose healthchecks already curl
// /healthz; flipping this from {ok:false} → {ok:true} only after
// bootstrapFrtb() resolves means an OOM-skipped or schema-missing api will
// mark `api` unhealthy at the orchestrator level instead of silently
// answering 200 with no idx:sens behind it (the Wave 5.14a failure mode).
export type BootstrapStatus =
  | { ok: true }
  | { ok: false; err?: string; reason?: string };

let bootstrapStatus: BootstrapStatus = { ok: false };

export function getBootstrapStatus(): BootstrapStatus {
  return bootstrapStatus;
}

export function markBootstrapReady(): void {
  bootstrapStatus = { ok: true };
}

export function markBootstrapFailed(err: unknown): void {
  bootstrapStatus = { ok: false, err: String(err) };
}

export function markBootstrapSkipped(reason: string): void {
  bootstrapStatus = { ok: false, reason };
}

// Test-only reset; not used by production code paths.
export function resetBootstrapStatusForTests(): void {
  bootstrapStatus = { ok: false };
}


// Connections store + routes are owned by the Connections-store agent. Loaded
// dynamically so this server boots even when that agent's files (store.ts,
// routes/connections.ts) are not yet on disk during cross-agent development.
export type ConnectionTester = (profile: unknown) => Promise<unknown>;
export type ConnectionsStore = unknown;

export interface CreateServerOpts {
  redis?: RedisLike;
  activeTarget?: ActiveTarget;
  correlations?: Record<string, CorrelationSpec>;
  logger?: boolean;
  store?: ConnectionsStore;
  tester?: ConnectionTester;
  // Upstream base URL for the source-service proxy. Falls back to
  // SOURCE_BASE env var, then to the compose-internal default.
  sourceBase?: string;
  // Upstream base URL for the loadgen-service proxy. Falls back to
  // LOADGEN_BASE env var, then to the compose-internal default.
  loadgenBase?: string;
  // SSE tick interval for /observability/shards/stream (default 1000ms). The
  // tests dial this down so the suite stays fast.
  sseIntervalMs?: number;
  // Wave 5.16g — explicit override for the CORS allow-list. When unset the
  // server reads `ALLOWED_ORIGINS` from the environment (comma-separated, or
  // `*` for any origin) and falls back to http://localhost:3000 — the nginx
  // ui container's host-mapped port. Threaded as an option so tests can
  // exercise restrictive and permissive lists without poking process.env.
  allowedOrigins?: string;
}

// Wave 5.16g — parse the ALLOWED_ORIGINS env-var pattern used by the demo
// compose stack. Returns the value to pass to @fastify/cors's `origin`
// option: `true` for "*" (echo any origin), an array for a comma-separated
// list (exact match), or a single string for the default single-origin
// case. The api uses no cookies, so credentialed CORS is intentionally off.
function parseAllowedOrigins(raw: string | undefined): true | string | string[] {
  const value = (raw ?? "http://localhost:3000").trim();
  if (value === "*") return true;
  const list = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (list.length === 0) return "http://localhost:3000";
  const [first] = list;
  if (list.length === 1 && first !== undefined) return first;
  return list;
}

export async function createServer(opts: CreateServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  // Wave 5.16g — register CORS before any route so OPTIONS preflight is
  // handled for every endpoint (including the dynamically-loaded
  // connections routes). The ui container fetches the api cross-origin
  // from http://localhost:3000 → http://localhost:8080; without this every
  // browser call surfaces as "Failed to fetch".
  await app.register(fastifyCors, {
    origin: parseAllowedOrigins(opts.allowedOrigins ?? process.env.ALLOWED_ORIGINS),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  if (opts.activeTarget) setActiveTarget(opts.activeTarget);

  app.get("/healthz", async (_req, reply) => {
    const s = getBootstrapStatus();
    if (!s.ok) {
      reply.code(503);
      const body: Record<string, string> = { status: "bootstrap-failed" };
      if (s.err) body.err = s.err;
      if (s.reason) body.reason = s.reason;
      return body;
    }
    return { service: "api", status: "ok", bootstrap: "ready" };
  });
  app.get("/redis/active-target", async () => getActiveTarget());

  if (opts.redis) {
    registerPivotRoute(app, opts.redis);
    registerCalcRoute(app, opts.redis, { correlations: opts.correlations ?? {} });
    registerObservabilityRoutes(app, opts.redis, { sseIntervalMs: opts.sseIntervalMs });
  }

  registerSourcesProxyRoutes(app, { sourceBase: opts.sourceBase });
  registerLoadgenProxyRoutes(app, { loadgenBase: opts.loadgenBase });

  if (opts.store) {
    const mod = await import("./routes/connections.ts").catch(() => null);
    if (mod && typeof (mod as { registerConnectionsRoutes?: unknown }).registerConnectionsRoutes === "function") {
      (mod as { registerConnectionsRoutes: (a: FastifyInstance, s: unknown, t?: unknown) => void })
        .registerConnectionsRoutes(app, opts.store, opts.tester);
    }
  }

  return app;
}
