import Fastify, { type FastifyInstance } from "fastify";
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
}

export async function createServer(opts: CreateServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

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
