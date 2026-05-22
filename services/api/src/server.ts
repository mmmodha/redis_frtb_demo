import Fastify, { type FastifyInstance } from "fastify";
import type { RedisLike } from "./redis-like.ts";
import type { CorrelationSpec } from "./sbm/reduce.ts";
import { getActiveTarget, setActiveTarget, type ActiveTarget } from "./active-target.ts";
import { registerPivotRoute } from "./routes/pivot.ts";
import { registerCalcRoute } from "./routes/calc.ts";
import { registerObservabilityRoutes } from "./routes/observability.ts";

export interface CreateServerOpts {
  redis: RedisLike;
  activeTarget?: ActiveTarget;
  correlations?: Record<string, CorrelationSpec>;
  logger?: boolean;
}

export async function createServer(opts: CreateServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  if (opts.activeTarget) setActiveTarget(opts.activeTarget);

  app.get("/healthz", async () => ({ service: "api", status: "ok" }));
  app.get("/redis/active-target", async () => getActiveTarget());

  registerPivotRoute(app, opts.redis);
  registerCalcRoute(app, opts.redis, { correlations: opts.correlations ?? {} });
  registerObservabilityRoutes(app, opts.redis);

  return app;
}
