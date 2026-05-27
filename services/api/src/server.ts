import Fastify, { type FastifyInstance } from "fastify";
import type { RedisLike } from "./redis-like.ts";
import type { CorrelationSpec } from "./sbm/reduce.ts";
import { getActiveTarget, setActiveTarget, type ActiveTarget } from "./active-target.ts";
import { registerPivotRoute } from "./routes/pivot.ts";
import { registerCalcRoute } from "./routes/calc.ts";
import { registerObservabilityRoutes } from "./routes/observability.ts";
import { registerSourcesProxyRoutes } from "./routes/sources-proxy.ts";
import { registerLoadgenProxyRoutes } from "./routes/loadgen-proxy.ts";

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

  app.get("/healthz", async () => ({ service: "api", status: "ok" }));
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
