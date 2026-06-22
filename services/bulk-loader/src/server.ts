// Wave 7.0.1.A / 7.0.1.B — bulk-loader HTTP control surface.
//
//   GET  /healthz        → 200 iff pool isHealthy() (≥75% workers connected).
//   GET  /load/status    → pool size, connected count, per-worker pool state
//                          + dispatcher in-flight / per-worker write metrics
//                          (queued, flushed, errors, retries, dead-lettered,
//                          last_flush_latency_ms) when a dispatcher is wired.
//   POST /load/start     → stub. Wave 7.0.1.C wires the generator producer
//                          into the dispatcher; this route stays a stub
//                          until then.

import Fastify, { type FastifyInstance } from "fastify";
import type { WorkerPool } from "./pool.ts";
import type { DispatcherHandle } from "./dispatcher.ts";

export interface CreateServerOpts {
  pool: WorkerPool;
  dispatcher?: DispatcherHandle;
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
    // Wave 7.0.1.B — merge per-worker write metrics onto each pool worker
    // entry so operators see a single combined view. last_flush_at is
    // sourced from the dispatcher (the actual flush timestamp) when present.
    const d = opts.dispatcher?.status();
    const dispatcherMetricsById = new Map<number, ReturnType<DispatcherHandle["status"]>["workers"][number]>();
    if (d) {
      for (const m of d.workers) dispatcherMetricsById.set(m.id, m);
    }
    const workers = s.workers.map((w) => {
      const m = dispatcherMetricsById.get(w.id);
      return {
        ...w,
        last_flush_at: m?.lastFlushAt ?? w.last_flush_at,
        queued: m?.queued ?? null,
        flushed: m?.flushed ?? null,
        errors: m?.errors ?? null,
        retries: m?.retries ?? null,
        dead_lettered: m?.deadLettered ?? null,
        last_flush_latency_ms: m?.lastFlushLatencyMs ?? null,
      };
    });
    return {
      pool_size: s.poolSize,
      connected: s.connected,
      dispatcher: d
        ? { in_flight: d.inFlight, high_water: d.highWater }
        : null,
      workers,
    };
  });

  app.post("/load/start", async (_req, reply) => {
    // Wave 7.0.1.B — dispatcher exists but rows arrive via 7.0.1.C's
    // generator wiring (out-of-scope for this wave). Returning 503 keeps
    // the route discoverable without pretending we accepted a job.
    reply.code(503);
    return {
      accepted: false,
      reason: "bulk writer: row producer wiring lands in Wave 7.0.1.C",
    };
  });

  return app;
}
