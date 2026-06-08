import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import type { Schema } from "@frtb/schema";
import type { RedisLike } from "./redis-like.ts";
import type { CorrelationSpec } from "./sbm/reduce.ts";
import {
  getActiveTarget,
  setActiveTarget,
  onActiveTargetChange,
  getActiveRedisClient,
  type ActiveTarget,
} from "./active-target.ts";
import {
  getBootstrapStatus as getBootstrapPhaseStatus,
  scheduleBootstrap,
} from "./bootstrap-status.ts";
import { registerPivotRoute } from "./routes/pivot.ts";
import { registerCalcRoute } from "./routes/calc.ts";
import { registerSuggestRoutes } from "./routes/suggest.ts";
import { registerFacetsRoute } from "./routes/facets.ts";
import { registerObservabilityRoutes } from "./routes/observability.ts";
import { registerSourcesProxyRoutes } from "./routes/sources-proxy.ts";
import { registerLoadgenProxyRoutes } from "./routes/loadgen-proxy.ts";
import { registerGeneratorRoutes } from "./routes/generator.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerInternalTargetRoutes } from "./routes/internal-target.ts";
import * as inflight from "./inflight-registry.ts";
import { corsHeadersForRequest } from "./cors-headers.ts";
import type { ConnectionsStore as RealConnectionsStore } from "./store.ts";

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
  // Wave 5.16t — fallback Redis client used ONLY when getActiveRedisClient()
  // returns null (i.e. no active profile has been set). Production wires the
  // accessor in `getRedis` below to follow the active-target singleton
  // per-request; this field is retained as a back-compat seam for unit tests
  // that inject a fakeRedis without touching the active-target state.
  redis?: RedisLike;
  // Wave 5.16t — explicit per-request accessor. Takes precedence over
  // `opts.redis`; production wires this to `() => getActiveRedisClient()` so
  // a profile switch retargets the very next route call without restarting.
  getRedis?: () => RedisLike;
  activeTarget?: ActiveTarget;
  correlations?: Record<string, CorrelationSpec>;
  // Loaded once at boot from $SCHEMA_FILE (see index.ts). Threaded through so
  // POST /generator/start can build per-class row generators without
  // re-reading the YAML per request. Optional so unit tests that don't
  // exercise the generator route can omit it.
  schema?: Schema;
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
  // Wave 5.20c — SSE progress-frame cadence for /generator/start/stream
  // (default 200ms). Tests dial this down so cancellation lands before a
  // small synthetic batch completes.
  generatorSseProgressIntervalMs?: number;
  // Wave 5.40a — grace window (ms) during which a terminal generator run
  // remains queryable via GET /generator/runs/:id/status. Default 30s.
  // Tests dial this down to verify grace-eviction.
  generatorTerminalGraceMs?: number;
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
  //
  // Wave 5.21i — the resolved allow-list is also threaded into every route
  // that calls `reply.hijack()` (SSE + proxy endpoints) so those hand-rolled
  // `writeHead` responses carry the same `access-control-allow-origin`
  // header @fastify/cors would have set via its onSend hook.
  const corsAllowed = parseAllowedOrigins(opts.allowedOrigins ?? process.env.ALLOWED_ORIGINS);
  await app.register(fastifyCors, {
    origin: corsAllowed,
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
  registerInternalTargetRoutes(app, opts.store as RealConnectionsStore | undefined);

  // Wave 5.16t — surface bootstrap progress to the UI so a freshly-activated
  // profile that's still loading idx:sens / the frtb library renders a
  // friendly "bootstrapping…" badge instead of opaque 500s on the first
  // calc/pivot call.
  app.get("/redis/active-target/bootstrap-status", async () => getBootstrapPhaseStatus());

  // Wave 5.16t — per-request accessor.
  //
  // Priority order:
  //   1. opts.getRedis — explicit accessor (production wires this in index.ts
  //      to follow the active-target singleton; tests use it to exercise
  //      per-request retargeting with a mutable fake).
  //   2. opts.redis — back-compat test seam: existing unit tests inject a
  //      single fakeRedis instance and expect it for the whole server life.
  //   3. getActiveRedisClient() — fall-back when nothing else is supplied.
  const getRedis = (): RedisLike => {
    if (opts.getRedis) return opts.getRedis();
    if (opts.redis) return opts.redis;
    const active = getActiveRedisClient();
    if (active) return active as unknown as RedisLike;
    // Last-resort: surface a clear error when nothing resolved.
    throw new Error("no active redis client and no fallback opts.redis provided");
  };

  registerPivotRoute(app, getRedis);
  registerCalcRoute(app, getRedis, { correlations: opts.correlations ?? {}, schema: opts.schema });
  registerSuggestRoutes(app, getRedis, { corsAllowed });
  registerFacetsRoute(app, getRedis);
  registerObservabilityRoutes(app, getRedis, { sseIntervalMs: opts.sseIntervalMs, corsAllowed });
  registerGeneratorRoutes(app, getRedis, opts.schema, {
    sseProgressIntervalMs: opts.generatorSseProgressIntervalMs,
    terminalGraceMs: opts.generatorTerminalGraceMs,
    corsAllowed,
  });
  registerAdminRoutes(app, getRedis, { schema: opts.schema });

  // Wave 5.16t — auto-bootstrap on every active-target change. The hook is
  // registered before the connections store so the very first profile-switch
  // dispatched by the UI triggers a background bootstrap; the route returns
  // 412 with friendly progress text via translateRedisError until ready.
  onActiveTargetChange((target) => {
    const client = getActiveRedisClient();
    scheduleBootstrap(
      target,
      // ioredis Redis|Cluster satisfies the bootstrap RedisLike surface.
      client as unknown as Parameters<typeof scheduleBootstrap>[1],
      opts.schema,
    );
  });

  registerSourcesProxyRoutes(app, { sourceBase: opts.sourceBase, corsAllowed });
  registerLoadgenProxyRoutes(app, { loadgenBase: opts.loadgenBase, corsAllowed });

  // Wave 5.16w — in-flight registry surface. Polled by the UI every 2s for
  // the lockout banner; SSE channel pushes immediate updates so the banner
  // appears/disappears without poll lag.
  app.get("/inflight", async () => inflight.snapshot());
  app.get("/inflight/stream", async (req, reply) => {
    const cors = corsHeadersForRequest(req, corsAllowed);
    reply.raw.writeHead(200, {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.hijack();
    let stopped = false;
    const send = (): void => {
      if (stopped) return;
      try { reply.raw.write(`event: change\ndata: ${JSON.stringify(inflight.snapshot())}\n\n`); }
      catch { /* socket closed */ }
    };
    send();
    const unsub = inflight.onChange(send);
    const ping = setInterval(() => {
      if (stopped) return;
      try { reply.raw.write(`: ping\n\n`); } catch { /* socket closed */ }
    }, 15_000);
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      unsub();
      clearInterval(ping);
      try { reply.raw.end(); } catch { /* socket already closed */ }
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });

  if (opts.store) {
    const mod = await import("./routes/connections.ts").catch(() => null);
    if (mod && typeof (mod as { registerConnectionsRoutes?: unknown }).registerConnectionsRoutes === "function") {
      (mod as { registerConnectionsRoutes: (a: FastifyInstance, s: unknown, t?: unknown) => void })
        .registerConnectionsRoutes(app, opts.store, opts.tester);
    }
  }

  return app;
}
