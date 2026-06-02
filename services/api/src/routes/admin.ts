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
  resolveMasterNodes,
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

  // Wave 5.47b — pre-flight checks. Probes idx:sens on every master, the
  // frtb function library, and the sensitivities:in stream so the UI can
  // surface a "rebuild indexes" banner before a generator run silently
  // produces unindexed rows. No body required; GET keeps it cacheable-free
  // and aligns with the read-only intent.
  app.get("/admin/preflight", async () => {
    const redis = getRedis();
    const masters = resolveMasterNodes(redis as unknown as BootstrapRedis);

    const missing: string[] = [];
    for (let i = 0; i < masters.length; i++) {
      try {
        await masters[i]!.call("FT.INFO", "idx:sens");
      } catch {
        missing.push(`node-${i}`);
      }
    }
    const idx_sens_ok = missing.length === 0;

    let loaded = true;
    for (const node of masters) {
      let found = false;
      try {
        const list = (await node.call("FUNCTION", "LIST")) as unknown[];
        if (Array.isArray(list)) {
          for (const entry of list) {
            if (!Array.isArray(entry)) continue;
            for (let i = 0; i + 1 < entry.length; i += 2) {
              if (entry[i] === "library_name" && entry[i + 1] === "frtb") {
                found = true;
                break;
              }
            }
            if (found) break;
          }
        }
      } catch {
        found = false;
      }
      if (!found) { loaded = false; break; }
    }

    let streamExists = false;
    try {
      const r = await redis.call("EXISTS", "sensitivities:in");
      streamExists = Number(r) > 0;
    } catch {
      streamExists = false;
    }

    let pingOk = true;
    try { await redis.call("PING"); } catch { pingOk = false; }

    const ok = idx_sens_ok && loaded && streamExists;
    return {
      ok,
      checks: {
        idx_sens: { ok: idx_sens_ok, missing },
        frtb_library: { ok: loaded, loaded },
        stream: { ok: streamExists, exists: streamExists },
      },
      can_rebuild: !ok && pingOk,
    };
  });

  // Wave 5.47b — one-click rebuild. Re-runs bootstrapFrtb against the active
  // redis client (same helper Wave 5.46 wires into the flush path). Idempotent
  // because ensureSensIndex / loadFrtbLibrary tolerate already-loaded state.
  app.post("/admin/rebuild-indexes", async () => {
    if (!opts.schema) {
      return { ok: false, ms: 0, bootstrap: { ok: false, error: "schema-missing" } };
    }
    const redis = getRedis();
    const t0 = process.hrtime.bigint();
    let bootstrap: { ok: boolean; error?: string };
    try {
      await runBootstrap(redis as unknown as BootstrapRedis, opts.schema);
      bootstrap = { ok: true };
    } catch (err) {
      bootstrap = {
        ok: false,
        error: String(err instanceof Error ? err.message : err),
      };
    }
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    return { ok: bootstrap.ok, ms, bootstrap };
  });
}
