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
import { getActiveTarget, type RuntimeCategory } from "../active-target.ts";
import {
  getBootstrapStatus,
  markBootstrapStatusRunning,
  markBootstrapStatusReady,
  markBootstrapStatusFailed,
  markBootstrapStatusPartial,
} from "../bootstrap-status.ts";
import {
  bootstrapFrtb,
  BootstrapPartialError,
  resolveMasterNodes,
  type BootstrapOpts,
  type RedisLike as BootstrapRedis,
} from "../bootstrap.ts";
import { getSensIndexName } from "../lib/sens-index.ts";
import { translateRedisError } from "../redis-errors.ts";
import { bumpDataVersion } from "../sbm/calc-cache.ts";
import { invalidateFacetsCache } from "./facets.ts";

export interface AdminRoutesOpts {
  // Threaded through from createServer so the post-flush bootstrap can rebuild
  // idx:sens + the frtb library. Optional: tests that exercise only the flush
  // path can omit it and assert the schema-missing branch.
  schema?: Schema;
  // Test seam — replaces bootstrapFrtb so unit tests can spy on the redis
  // client passed in and inject throw/ok behaviour without booting RediSearch.
  // Wave 6.18i — opts carry the optional `{ target_label, force }` so admin
  // routes can plumb the active label + a ?force=true override through to
  // the skip-when-unchanged path.
  bootstrap?: (
    client: BootstrapRedis,
    schema: Schema,
    log?: (entry: Record<string, unknown>) => void,
    opts?: BootstrapOpts,
  ) => Promise<unknown>;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  getRedis: (category?: RuntimeCategory) => RedisLike,
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

    // Wave 5.83C-2 — bump the /calc/sbm response-cache data version so the
    // freshly-wiped target serves a cache miss on the next Calculate call.
    // Best-effort: a failed INCR still invalidates the in-process map.
    await bumpDataVersion(redis);

    let bootstrap: { ok: boolean; error?: string; cache_invalidated?: boolean; cache_invalidate_error?: string };
    if (!opts.schema) {
      bootstrap = { ok: false, error: "schema-missing" };
    } else {
      markBootstrapStatusRunning(target_label);
      try {
        // Wave 6.18i — flush wipes idx:sens and the schema-hash key
        // alongside the data, so the very next bootstrap must rebuild.
        // Forcing the rebuild keeps that contract explicit even though
        // the missing hash key would also force a rebuild on its own.
        await runBootstrap(
          redis as unknown as BootstrapRedis,
          opts.schema,
          undefined,
          { target_label, force: true },
        );
        markBootstrapStatusReady(target_label);
        bootstrap = { ok: true };
        // Wave 5.86C — drop the /facets in-process cache so the UI sees
        // post-flush row counts immediately instead of waiting up to 30 s
        // for the entry to expire (active-target identity is unchanged, so
        // onActiveTargetChange would not fire on its own). Non-fatal:
        // the flush + bootstrap already succeeded, we just surface a
        // warning on the body if invalidation throws.
        try {
          invalidateFacetsCache();
          bootstrap.cache_invalidated = true;
        } catch (err) {
          bootstrap.cache_invalidated = false;
          bootstrap.cache_invalidate_error = String(err instanceof Error ? err.message : err);
        }
      } catch (err) {
        // Wave 6.16a — distinguish partial-fan-out from total failure so the
        // bootstrap-status surface keeps per-node remediation info instead of
        // collapsing every failure mode to `failed`.
        if (err instanceof BootstrapPartialError) {
          markBootstrapStatusPartial(target_label, err.failures);
        } else {
          markBootstrapStatusFailed(target_label, err);
        }
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
  //
  // Wave 5.54 — the stream check is informational only: the stream is the
  // OUTPUT of the generator, not a precondition for it. Gating the generator
  // on its existence created a chicken-and-egg deadlock on fresh Redis
  // targets. Only idx_sens + frtb_library participate in the ok gate now.
  // Wave 6.21 — /admin/preflight is a fast read-only check (FT.INFO + a few
  // EVALSHA probes); migrate to the light pool so a degraded heavy member
  // (slow calc) cannot stall the UI's pre-Calculate sanity check.
  app.get("/admin/preflight", { config: { category: "light" } }, async (req) => {
    const redis = getRedis(req.poolCategory);
    const masters = resolveMasterNodes(redis as unknown as BootstrapRedis);

    // Wave 6.18i — probe the versioned `idx:sens:v{hash7}` name when the
    // active target has a persisted schema hash; fall back to the legacy
    // base name otherwise so pre-6.18i targets still preflight cleanly.
    let probeIndex = "idx:sens";
    try {
      const lbl = getActiveTarget().label;
      probeIndex = await getSensIndexName(redis, lbl);
    } catch { /* no active target — keep base name */ }
    const missing: string[] = [];
    for (let i = 0; i < masters.length; i++) {
      try {
        await masters[i]!.call("FT.INFO", probeIndex);
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

    // Wave 6.16a — when bootstrap-status persisted a partial verdict, fold
    // those per-node failures into the preflight surface so both endpoints
    // agree on the missing-index / missing-library set. Runtime FT.INFO /
    // FUNCTION LIST probes can race with the rebuild itself (idx briefly
    // gone while ensureSensIndex re-creates), so persisted failures are
    // additive — never narrower than the live probe.
    const bsStatus = getBootstrapStatus();
    let partialMissingIndex: string[] = [];
    let partialFuncFailed = false;
    if (bsStatus.phase === "partial" && Array.isArray(bsStatus.failures)) {
      for (const f of bsStatus.failures) {
        if (f.step === "idx:sens") partialMissingIndex.push(f.node_id);
        if (f.step === "frtb") partialFuncFailed = true;
      }
    }
    const idxMissingSet = new Set<string>([...missing, ...partialMissingIndex]);
    const finalMissing = Array.from(idxMissingSet);
    const finalIdxOk = finalMissing.length === 0;
    const finalLoaded = loaded && !partialFuncFailed;

    const ok = finalIdxOk && finalLoaded;
    return {
      ok,
      checks: {
        idx_sens: { ok: finalIdxOk, missing: finalMissing },
        frtb_library: { ok: finalLoaded, loaded: finalLoaded },
        stream: { ok: streamExists, exists: streamExists },
      },
      can_rebuild: !ok && pingOk,
    };
  });

  // Wave 5.47b — one-click rebuild. Re-runs bootstrapFrtb against the active
  // redis client (same helper Wave 5.46 wires into the flush path). Idempotent
  // because ensureSensIndex / loadFrtbLibrary tolerate already-loaded state.
  //
  // Wave 5.54 — also creates the sensitivities:in stream + ingest consumer
  // group via XGROUP CREATE ... MKSTREAM. Defaults mirror
  // services/ingest/src/cli.ts (STREAM_KEY / CONSUMER_GROUP) so a fresh Redis
  // is fully wired after a single rebuild click. BUSYGROUP (group already
  // exists, MKSTREAM is a no-op) is tolerated; other XGROUP errors are
  // logged but do not fail the rebuild because bootstrap itself succeeded.
  app.post("/admin/rebuild-indexes", async (req) => {
    if (!opts.schema) {
      return { ok: false, ms: 0, bootstrap: { ok: false, error: "schema-missing" } };
    }
    const redis = getRedis();
    // Wave 6.16a — keep the active target_label so we can update the
    // bootstrap-status flag on the way out. Pre-rebuild status may be
    // partial (from boot) or anything else; we transition based on
    // outcome rather than the prior phase so re-runs are idempotent.
    let target_label = "";
    try { target_label = getActiveTarget().label; } catch { /* no active target */ }
    // Wave 6.18i — `?force=true` bypasses the skip-when-unchanged check so
    // operators can force a versioned-index rebuild even when the
    // persisted schema-hash key matches (recovery from index corruption,
    // post-incident sanity rebuilds, etc.). Default false → fast skip
    // when nothing changed.
    const query = (req.query ?? {}) as Record<string, unknown>;
    const force = String(query.force ?? "").toLowerCase() === "true";
    const t0 = process.hrtime.bigint();
    let bootstrap: { ok: boolean; error?: string };
    try {
      await runBootstrap(
        redis as unknown as BootstrapRedis,
        opts.schema,
        undefined,
        target_label ? { target_label, force } : { force },
      );
      bootstrap = { ok: true };
      // Wave 6.16a — successful rebuild transitions partial → ready (or
      // any-prior-state → ready). Only fired when target_label is known
      // so tests that omit setActiveTarget don't drag a phantom label
      // onto the snapshot.
      if (target_label) markBootstrapStatusReady(target_label);
    } catch (err) {
      bootstrap = {
        ok: false,
        error: String(err instanceof Error ? err.message : err),
      };
      // Wave 6.16a — partial-again stays partial; total failures stay
      // failed. Both surface via /redis/active-target/bootstrap-status.
      if (target_label) {
        if (err instanceof BootstrapPartialError) {
          markBootstrapStatusPartial(target_label, err.failures);
        } else {
          markBootstrapStatusFailed(target_label, err);
        }
      }
    }

    if (bootstrap.ok) {
      const stream = process.env.STREAM_KEY ?? "sensitivities:in";
      const group = process.env.CONSUMER_GROUP ?? "ingest";
      try {
        await redis.call("XGROUP", "CREATE", stream, group, "$", "MKSTREAM");
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (!msg.includes("BUSYGROUP")) {
          req.log.warn({ err: msg, stream, group }, "rebuild: XGROUP CREATE MKSTREAM failed");
        }
      }
    }

    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    return { ok: bootstrap.ok, ms, bootstrap };
  });
}
