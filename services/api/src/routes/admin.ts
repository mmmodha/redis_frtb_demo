// Wave 5.38c — POST /admin/flush.
//
// Presenter-facing escape hatch for clearing the active Redis target during a
// demo. Issues FLUSHDB against the active client (single-master path) and
// returns the elapsed time so the UI can render a "Flushed in {ms}ms" banner.
// Multi-shard cluster reset stays on the scripts/smoke-reset-cluster.sh CLI.

import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";

export function registerAdminRoutes(
  app: FastifyInstance,
  getRedis: () => RedisLike,
): void {
  app.post("/admin/flush", async (_req, reply) => {
    let target_label: string;
    try {
      target_label = getActiveTarget().label;
    } catch {
      reply.code(503);
      return { error: "no active target" };
    }
    if (!target_label) {
      reply.code(503);
      return { error: "no active target" };
    }
    const redis = getRedis();
    const t0 = process.hrtime.bigint();
    try {
      await redis.flushdb();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { ok: true, ms: Math.round(ms), target_label };
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
  });
}
