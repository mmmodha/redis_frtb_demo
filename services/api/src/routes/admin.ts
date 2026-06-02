// Wave 5.38c — POST /admin/flush.
//
// Presenter-facing escape hatch for clearing the active Redis target during a
// demo. Issues FLUSHDB against the active client (single-master path) and
// returns the elapsed time so the UI can render a "Flushed in {ms}ms" banner.
// Multi-shard cluster reset stays on the scripts/smoke-reset-cluster.sh CLI.
//
// Wave 5.46 — FLUSHDB wipes idx:sens and the frtb library along with the
// data, so the next /calc/sbm hits "Unknown Index name". Re-run bootstrapFrtb
// inline so the response carries `bootstrap: { ok: true }` and the next
// Calculate call lands on a primed cluster. Bootstrap failures don't fail the
// flush — they're surfaced as `bootstrap.ok: false` so the UI can warn.

import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import {
  getBootstrapStatus,
  markBootstrapStatusRunning,
  markBootstrapStatusReady,
  markBootstrapStatusFailed,
} from "../bootstrap-status.ts";
import {
  bootstrapFrtb,
  type RedisLike as BootstrapRedis,
} from "../bootstrap.ts";
import { translateRedisError } from "../redis-errors.ts";

export interface AdminRoutesOpts {
  // Threaded through from createServer so the post-flush bootstrap can rebuild
  // idx:sens + the frtb library. Optional: tests that exercise only the flush
  // path can omit it and assert the schema-missing branch.
  schema?: Schema;
  // Test seam — replaces bootstrapFrtb so unit tests can spy on the redis
  // client passed in and inject throw/ok behaviour without booting RediSearch.
  bootstrap?: (client: BootstrapRedis, schema: Schema) => Promise<unknown>;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  getRedis: () => RedisLike,
  opts: AdminRoutesOpts = {},
): void {
  const runBootstrap = opts.bootstrap ?? bootstrapFrtb;

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
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

    let bootstrap: { ok: boolean; error?: string };
    if (!opts.schema) {
      bootstrap = { ok: false, error: "schema-missing" };
    } else {
      markBootstrapStatusRunning(target_label);
      try {
        await runBootstrap(redis as unknown as BootstrapRedis, opts.schema);
        markBootstrapStatusReady(target_label);
        bootstrap = { ok: true };
      } catch (err) {
        markBootstrapStatusFailed(target_label, err);
        bootstrap = {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    }

    return { ok: true, ms, target_label, bootstrap };
  });
}
