import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import fastifyCors from "@fastify/cors";
import type { Schema } from "@frtb/schema";
import type { RedisLike } from "./redis-like.ts";
import type { CorrelationSpec } from "./sbm/reduce.ts";
import {
  getActiveTarget,
  setActiveTarget,
  isActiveTargetConfigured,
  onActiveTargetChange,
  getActiveRedisClient,
  getActiveRedisRuntimeClient,
  probeRuntimeRedisReadiness,
  type ActiveTarget,
  type RuntimeCategory,
} from "./active-target.ts";
import {
  getBootstrapStatus as getBootstrapPhaseStatus,
  scheduleBootstrap,
  setBootstrapSelfHealCallback,
} from "./bootstrap-status.ts";
import { schemaHashKey } from "./lib/sens-index.ts";
import { clearDriftResults } from "./jobs/drift-detector.ts";
import { registerPivotRoute } from "./routes/pivot.ts";
import { registerCalcRoute } from "./routes/calc.ts";
import { registerSuggestRoutes } from "./routes/suggest.ts";
import { registerFacetsRoute } from "./routes/facets.ts";
import { registerObservabilityRoutes } from "./routes/observability.ts";
import { registerSourcesProxyRoutes } from "./routes/sources-proxy.ts";
import { registerLoadgenProxyRoutes } from "./routes/loadgen-proxy.ts";
import { registerIngestShardsRoutes } from "./routes/ingest-shards.ts";
import { registerIngestRoutes } from "./routes/ingest.ts";
import { registerGeneratorRoutes } from "./routes/generator.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerInternalTargetRoutes } from "./routes/internal-target.ts";
import * as inflight from "./inflight-registry.ts";
import { corsHeadersForRequest } from "./cors-headers.ts";
import { registerBackpressure } from "./backpressure.ts";
import { pushRecentError } from "./ops/recent-errors.ts";
import { appendLog, ingestPinoLine } from "./ops/log-buffer.ts";
import type { ConnectionsStore as RealConnectionsStore } from "./store.ts";
// Wave 6.21 (B1) — side-effect import: brings the FastifyContextConfig.category
// + FastifyRequest.poolCategory module augmentation into scope so route files
// can declare `config: { category: "light" }` and read `req.poolCategory`.
import "./fastify-augmentations.ts";

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
  //
  // Wave 6.21 — the accessor now takes an optional pool category. Routes that
  // want light-pool isolation call `getRedis("light")`; everything else
  // defaults to heavy. Tests that override `getRedis` may ignore the argument
  // (returning the same fake for both categories is fine and intended for the
  // existing FakeRedis-based suite).
  //
  // Wave 6.56.D4 — production accessor became async (it awaits pool-member
  // readiness in `acquireFromPool`); the union return type lets test seams
  // keep returning a sync fake without rewriting every suite, while the
  // production wiring in index.ts/server.ts returns a Promise.
  getRedis?: (category?: RuntimeCategory) => RedisLike | Promise<RedisLike>;
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
  // Wave 6.12a — upstream base URL for the ingest shard-control proxy.
  // Falls back to INGEST_URL env var, then to the compose-internal default.
  ingestBase?: string;
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
  // Wave 6.44.E — override the `fetch` used by /admin/cancel-all-runs to
  // call the ingest /ingest/halt-and-flush endpoint. Tests inject a stub
  // so they can assert the proxy without standing up a real ingest service.
  generatorFetchImpl?: typeof fetch;
  // Wave 6.44.E — best-effort window (ms) for cancel flags to propagate
  // before /admin/cancel-all-runs proxies to ingest. Tests dial this down
  // so the suite stays fast (no real producer loop to observe the flag).
  generatorCancelDrainMs?: number;
  // Wave 5.16g — explicit override for the CORS allow-list. When unset the
  // server reads `ALLOWED_ORIGINS` from the environment (comma-separated, or
  // `*` for any origin) and falls back to http://localhost:3000 — the nginx
  // ui container's host-mapped port. Threaded as an option so tests can
  // exercise restrictive and permissive lists without poking process.env.
  allowedOrigins?: string;
  // Wave 6.26 — override the runtime-pool readiness probe used by /readyz.
  // Production leaves this unset and the handler defaults to the real
  // `probeRuntimeRedisReadiness()` from active-target.ts (PING-based, 250ms
  // cached). When a test injects `opts.redis` (in-process fakeRedis) the
  // runtime pool is bypassed entirely, so the probe is skipped to preserve
  // the legacy /readyz contract (boot-status-only) those tests assert
  // against. `opts.getRedis` does NOT skip the probe — that path is the
  // production wiring the gate exists to protect. Tests that want to
  // exercise the probe gate explicitly pass a fake here.
  readinessProbe?: () => Promise<{ ok: boolean; err?: string }>;
  // Wave 7.0.6.13 — bulk-loader base URL for POST /ingest/bulk/start. Falls
  // back to BULK_LOADER_URL / BULK_LOADER_PORT inside the handler.
  bulkLoaderBase?: string;
  // Wave 7.0.6.13 — fetch override for the bulk-loader producer. Tests inject
  // a stub so they can drive /ingest/bulk/start without standing up a real
  // bulk-loader.
  ingestFetchImpl?: typeof fetch;
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

function buildPinoLoggerConfig(): { level: string; stream: pino.MultiStreamRes } {
  const ring = new Writable({
    write(chunk, _encoding, callback) {
      ingestPinoLine(chunk.toString());
      callback();
    },
  });
  return {
    level: process.env.LOG_LEVEL ?? "info",
    stream: pino.multistream([
      { stream: process.stdout },
      { stream: ring },
    ]),
  };
}

export async function createServer(opts: CreateServerOpts): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? buildPinoLoggerConfig() : false,
    requestIdHeader: "x-request-id",
    genReqId: (req) => {
      const hdr = req.headers["x-request-id"];
      if (typeof hdr === "string" && hdr.length > 0) return hdr;
      return randomUUID();
    },
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = e.message || "Internal Server Error";
    if (status >= 500) {
      pushRecentError({
        request_id: req.id,
        method: req.method,
        route: (req.url.split("?", 1)[0] ?? req.url),
        status_code: status,
        error: message,
        detail: e.stack?.split("\n").slice(0, 4).join("\n"),
      });
    }
    if (!reply.sent) {
      reply.status(status).send({
        error: message,
        request_id: req.id,
        statusCode: status,
      });
    }
  });

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

  // Wave 6.21 (B1) — resolve the route-level pool category onto the request
  // BEFORE any preHandler / handler body runs. Routes declare `config:
  // { category: "heavy-calc" | "heavy-ingest" | "light" }`; everything else
  // defaults to heavy-calc. Registered ahead of `registerBackpressure` so the
  // 6.23 semaphore middleware can read `req.poolCategory` rather than
  // re-deriving the category from the URL. `decorateRequest` gives every
  // request a default value so the property access is monomorphic; the hook
  // then overwrites it from route config.
  //
  // Wave 6.40.X — the default is `"heavy-calc"` (formerly `"heavy"`) so any
  // unmigrated route lands on the safer/longer-timeout pool. Routes that
  // perform XADD writes opt in to `"heavy-ingest"`. The `"heavy"` value is
  // still accepted from route config for backward compatibility — see the
  // alias normalisation in active-target.ts.
  app.decorateRequest("poolCategory", "heavy-calc");
  app.addHook("onRequest", async (req) => {
    const cfg = req.routeOptions?.config as { category?: RuntimeCategory } | undefined;
    req.poolCategory = cfg?.category ?? "heavy-calc";
  });

  // Wave 6.23 — per-category concurrency limits. Registered before any
  // route so the onRequest hook gates everything (the heavy/light split
  // exempts /healthz, /readyz, /redis/active-target*, /inflight*, and SSE
  // streams). Defaults from MAX_INFLIGHT_HEAVY / MAX_INFLIGHT_LIGHT.
  registerBackpressure(app);

  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 400) {
      const route = req.url.split("?", 1)[0] ?? req.url;
      appendLog({
        level: reply.statusCode >= 500 ? "error" : "warn",
        msg: `${req.method} ${route} → ${reply.statusCode}`,
        request_id: req.id,
        status_code: reply.statusCode,
        route,
      });
    }
  });

  if (opts.activeTarget) {
    setActiveTarget(opts.activeTarget);
  } else if (opts.redis && !isActiveTargetConfigured()) {
    // Unit tests inject fakeRedis without wiring the active-target singleton.
    // Install a stable label so routes that key off target_label keep working
    // without reintroducing the production localhost fallback.
    setActiveTarget({
      host: "127.0.0.1",
      port: 6379,
      tls: false,
      db: 0,
      label: "test-default",
    });
  }

  // Wave 5.97D.1 — split health into k8s-style liveness + readiness probes.
  //   /healthz: liveness. Always 200 once the api process is accepting
  //     traffic. Never gates on Redis or bootstrap. Used by Docker /
  //     orchestrators / `scripts/run-local.sh` to know "is the process up?"
  //   /readyz: readiness. 503 with `bootstrap-failed` until Redis is reachable
  //     and bootstrapFrtb() resolves; 200 thereafter. Replicates the pre-split
  //     /healthz behaviour verbatim. Used by callers that need to know "is the
  //     api ready to serve Redis-backed routes?"
  // Splitting the two unblocks the fresh-clone `docker compose up -d --wait`
  // happy path: the compose healthcheck (process-alive) can pass before any
  // Redis is configured, and downstream services no longer wedge themselves
  // believing the api is down when only Redis is missing.
  // Wave 6.21 — `/healthz` and `/readyz` are Redis-free probes but get
  // `light` category so any future change that adds a Redis read (e.g.
  // surfacing `INFO server` in `/healthz`) lands on the light pool by
  // default, never on a heavy slot that might be saturated by a slow calc.
  app.get("/healthz", { config: { category: "light" } }, async () => {
    return { service: "api", status: "alive" };
  });
  // Wave 6.26 — pick the readiness probe used by /readyz below.
  //   * Explicit `opts.readinessProbe` always wins (tests of the gate).
  //   * `opts.redis` is the legacy in-process fake injection (e.g. fakeRedis):
  //     routes use that fake directly, the real runtime pool is never built,
  //     and the gate stays boot-status-only to preserve the pre-6.26 contract
  //     those tests assert against.
  //   * `opts.getRedis` is the production-style lazy accessor (index.ts wires
  //     it to `getActiveRedisRuntimeClient`). It MUST NOT skip the probe —
  //     this is the exact code path /readyz needs to gate. Skipping it here
  //     was the original 6.26 bug: production wires `opts.getRedis`, so the
  //     probe never ran and /readyz flipped green before the runtime pool's
  //     sockets were writable, reproducing the "Stream isn't writeable" 500s.
  //   * Production: default to the real runtime-pool probe so /readyz
  //     refuses to flip green until heavy + light pool sockets are
  //     writable (see the diagnosis comment on `probeRuntimeRedisReadiness`).
  const readinessProbe: (() => Promise<{ ok: boolean; err?: string }>) | null =
    opts.readinessProbe
      ?? (opts.redis ? null : probeRuntimeRedisReadiness);
  app.get("/readyz", { config: { category: "light" } }, async (_req, reply) => {
    const s = getBootstrapStatus();
    if (!s.ok) {
      reply.code(503);
      const body: Record<string, string> = { status: "bootstrap-failed" };
      if (s.err) body.err = s.err;
      if (s.reason) body.reason = s.reason;
      return body;
    }
    if (readinessProbe) {
      const r = await readinessProbe();
      if (!r.ok) {
        reply.code(503);
        const body: Record<string, string> = { status: "runtime-pool-not-ready" };
        if (r.err) body.err = r.err;
        return body;
      }
    }
    return { service: "api", status: "ok", bootstrap: "ready" };
  });
  // Wave 6.21 — `/redis/active-target` is a tiny in-memory read (no Redis
  // call) but the GET is exempted from heavy/light backpressure already; mark
  // it `light` for symmetry with the rest of the read endpoints.
  app.get("/redis/active-target", { config: { category: "light" } }, async (_req, reply) => {
    const t = getActiveTarget();
    if (!t.label) {
      reply.code(503);
      return { error: "no active target" };
    }
    return t;
  });
  registerInternalTargetRoutes(app, opts.store as RealConnectionsStore | undefined);

  // Wave 5.16t — surface bootstrap progress to the UI so a freshly-activated
  // profile that's still loading idx:sens / the frtb library renders a
  // friendly "bootstrapping…" badge instead of opaque 500s on the first
  // calc/pivot call.
  app.get(
    "/redis/active-target/bootstrap-status",
    { config: { category: "light" } },
    async () => getBootstrapPhaseStatus(),
  );

  // Wave 5.16t — per-request accessor.
  //
  // Priority order:
  //   1. opts.getRedis — explicit accessor (production wires this in index.ts
  //      to follow the active-target singleton; tests use it to exercise
  //      per-request retargeting with a mutable fake).
  //   2. opts.redis — back-compat test seam: existing unit tests inject a
  //      single fakeRedis instance and expect it for the whole server life.
  //   3. getActiveRedisRuntimeClient() — fall-back when nothing else is
  //      supplied. Wave 6.18f: routes resolve to the RUNTIME client (35s
  //      commandTimeout) so the in-Redis FT_AGGREGATE TIMEOUT (30s) can fire
  //      first; the boot client (10s) remains reserved for `bootstrapFrtb` +
  //      `scheduleBootstrap` callers.
  // Wave 6.21 / 6.40.X — category defaults to `"heavy-calc"` so a route that
  // hasn't been explicitly migrated stays on the safest runtime client (35s
  // command-timeout budget). Routes opt in to `"light"` / `"heavy-ingest"`
  // by declaring `config: { category: ... }` on the route definition; the
  // handler then calls `getRedis(req.poolCategory)` — never a hardcoded
  // literal — so the choice is visible at hook time for 6.23's semaphore
  // middleware.
  // Wave 6.56.D4 — accessor is async because the runtime path now awaits
  // pool-member readiness; sync test seams (opts.getRedis / opts.redis) are
  // still accepted and just resolve immediately.
  const getRedis = async (category: RuntimeCategory = "heavy-calc"): Promise<RedisLike> => {
    if (opts.getRedis) return await opts.getRedis(category);
    if (opts.redis) return opts.redis;
    const active = await getActiveRedisRuntimeClient(category);
    if (active) return active as unknown as RedisLike;
    // Last-resort: surface a clear error when nothing resolved.
    throw new Error("no active redis client and no fallback opts.redis provided");
  };

  registerPivotRoute(app, getRedis, { schema: opts.schema });
  registerCalcRoute(app, getRedis, { correlations: opts.correlations ?? {}, schema: opts.schema });
  registerSuggestRoutes(app, getRedis, { corsAllowed });
  registerFacetsRoute(app, getRedis, { schema: opts.schema });
  registerObservabilityRoutes(app, getRedis, { sseIntervalMs: opts.sseIntervalMs, corsAllowed });
  registerGeneratorRoutes(app, getRedis, opts.schema, {
    sseProgressIntervalMs: opts.generatorSseProgressIntervalMs,
    terminalGraceMs: opts.generatorTerminalGraceMs,
    corsAllowed,
    // Wave 6.44.E — POST /admin/cancel-all-runs needs the ingest base URL
    // so it can call /ingest/halt-and-flush after flipping cancel flags.
    // Falls back to INGEST_URL env var inside the handler.
    ingestBase: opts.ingestBase,
    fetchImpl: opts.generatorFetchImpl,
    cancelDrainMs: opts.generatorCancelDrainMs,
  });
  registerAdminRoutes(app, getRedis, { schema: opts.schema });

  // Wave 7.0.6.13 — bulk-loader fast-path ingest route. Drives the
  // bulk-loader (POST :8086/load/rows) from the UI's "Start ingest" button so
  // the demo bypasses the latency-bound stream consumer.
  registerIngestRoutes(app, opts.schema, {
    bulkLoaderBase: opts.bulkLoaderBase,
    fetchImpl: opts.ingestFetchImpl,
    getRedis,
  });

  // Wave 5.16t — auto-bootstrap on every active-target change. The hook is
  // registered before the connections store so the very first profile-switch
  // dispatched by the UI triggers a background bootstrap; the route returns
  // 412 with friendly progress text via translateRedisError until ready.
  // Wave 6.39.I — also clear the in-memory drift-detector ring buffer so
  // entries from the previous target don't leak into /admin/drift-status
  // after a profile switch (the rc:bucket keys refer to data that doesn't
  // exist on the new target).
  // Wave 7.0.6.10 — pass `force: true` so re-activating the SAME profile
  // (idempotent UI click, or a restart that auto-activates the persisted
  // target) deterministically re-verifies the index instead of short-
  // circuiting on a stale `phase=ready` snapshot. The runner's own
  // schema-hash + FT.INFO probe keeps the no-op case cheap (`bootstrap-skip`
  // log, single FT.INFO per master), but a wiped index now self-heals.
  onActiveTargetChange((target) => {
    clearDriftResults();
    const client = getActiveRedisClient();
    scheduleBootstrap(
      target,
      // ioredis Redis|Cluster satisfies the bootstrap RedisLike surface.
      client as unknown as Parameters<typeof scheduleBootstrap>[1],
      opts.schema,
      { force: true },
    );
  });

  // Wave 6.39.I — install the bootstrap self-heal callback. Fired from
  // translateRedisError when an FT.AGGREGATE call surfaces "index not
  // found" (almost always the after-effect of a dev FLUSHDB against the
  // active target). DELs the persisted schema-hash sentinel and re-arms
  // scheduleBootstrap so the index is recreated without a process restart.
  setBootstrapSelfHealCallback(() => {
    const target = (() => { try { return getActiveTarget(); } catch { return null; } })();
    if (!target) return;
    const client = getActiveRedisClient();
    if (!client) return;
    // Drop the canonical schema-hash key so bootstrapFrtb's skip-when-
    // unchanged path can't short-circuit. Best-effort: a missing key (the
    // common case after FLUSHDB) is a no-op.
    void (async () => {
      try {
        await (client as unknown as { call: (cmd: string, ...args: unknown[]) => Promise<unknown> })
          .call("DEL", schemaHashKey(target.label));
      } catch { /* DEL failure must not block self-heal scheduling */ }
      // Wave 7.0.6.10 — force the schedule so the post-FLUSHDB self-heal
      // can't be short-circuited by a residual `phase=ready` snapshot tied
      // to the same target_label (triggerBootstrapSelfHeal flips ready→idle
      // but a concurrent re-fire could land on a freshly-marked ready).
      scheduleBootstrap(
        target,
        client as unknown as Parameters<typeof scheduleBootstrap>[1],
        opts.schema,
        { force: true },
      );
    })();
  });

  registerSourcesProxyRoutes(app, { sourceBase: opts.sourceBase, corsAllowed });
  registerLoadgenProxyRoutes(app, { loadgenBase: opts.loadgenBase, corsAllowed });
  registerIngestShardsRoutes(app, { ingestBase: opts.ingestBase, corsAllowed });

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
