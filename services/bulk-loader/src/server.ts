// Wave 7.0.1.A — bulk-loader HTTP control surface (skeleton).
//
//   GET  /healthz        → 200 iff pool isHealthy() (≥75% workers connected).
//   GET  /load/status    → pool size, connected count, per-worker state +
//                          last_heartbeat + last_flush_at.
//   POST /load/start     → stub. Worker write path lands in Wave 7.0.1.B;
//                          this route exists so the surface is stable and
//                          the run-local.sh process manager can wire it.

import Fastify, { type FastifyInstance } from "fastify";
import type { WorkerPool } from "./pool.ts";

export interface CreateServerOpts {
  pool: WorkerPool;
  logger?: boolean;
}

export async function createServer(opts: CreateServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/healthz", async (_req, reply) => {
    const s = opts.pool.status();
    const healthy = opts.pool.isHealthy();
    reply.code(healthy ? 200 : 503);
    return {
      service: "bulk-loader",
      status: healthy ? "ok" : "degraded",
      connected: s.connected,
      pool_size: s.poolSize,
    };
  });

  app.get("/load/status", async () => {
    const s = opts.pool.status();
    return {
      pool_size: s.poolSize,
      connected: s.connected,
      workers: s.workers,
    };
  });

  app.post("/load/start", async (_req, reply) => {
    // Wave 7.0.1.A — write path is intentionally not wired here. Returning
    // 503 (Service Unavailable) keeps the route discoverable without
    // pretending we accepted a job. Wave 7.0.1.B replaces this stub.
    reply.code(503);
    return {
      accepted: false,
      reason: "bulk writer skeleton: write path lands in Wave 7.0.1.B",
    };
  });

  return app;
}
