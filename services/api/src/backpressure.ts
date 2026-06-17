// Wave 6.23 — per-category in-flight concurrency limits.
//
// Two independent semaphores (heavy + light) gate route admission at the
// Fastify hook layer. Heavy routes (FCALL / FT.AGGREGATE — /calc, /pivot,
// /facets) share one budget so a UI navigation that fans out a dozen /calc
// calls cannot pile work onto the small Redis runtime pool faster than it
// drains. Light routes (Redis commands measured in microseconds —
// admin/observability/connections) get their own larger budget so heavy
// saturation does NOT starve them.
//
// Request-level gate, not connection-level: ioredis pipelines commands on
// each pool member, so a single admitted /calc request can fan out many
// internal Redis commands over the pool. The semaphore caps how many
// CONCURRENT REQUESTS we will admit; the per-pool round-robin (Wave 6.21)
// is what isolates blast radius between requests. Default per-category
// limit is `2 × getRuntimePoolSize(category)` so the in-flight budget
// always scales with the pool the env actually sized.
//
// Category resolution (Wave 6.23 spec correction B1) — read from the
// Fastify route config (`req.routeOptions.config.category`) so the
// preHandler can decide before the handler body runs. Routes that haven't
// been migrated yet default to "heavy" (the safer choice; missing
// declarations get logged once per URL).
//
// When a semaphore is full new requests get a 503 immediately (NO server-
// side queueing) with a structured body the UI/clients can recognise and a
// `Retry-After` header so well-behaved callers back off. Streaming SSE
// endpoints and the liveness/readiness probes are exempt — they hold their
// sockets open or must always answer.
//
// Released either on response completion or aborted connections so a
// dropped socket never permanently leaks a slot.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getRuntimePoolSize, type RuntimeCategory } from "./active-target.ts";

export type Category = "heavy" | "light" | "exempt";

// URL-based exemption list. Kept narrow on purpose — these routes either
// (a) must always answer regardless of saturation (liveness/readiness,
// active-target inspection used by ops to recover from a stuck instance),
// or (b) hold a socket open for SSE so semaphore accounting would consume
// the budget without doing per-request Redis work. Everything else is
// classified by route config (or defaulted to heavy).
const EXEMPT_EXACT = new Set(["/healthz", "/readyz"]);
const EXEMPT_PREFIXES = [
  "/redis/active-target",
  "/inflight",
  "/internal/redis/active-target",
] as const;

const DEFAULT_RETRY_AFTER_MS = 1000;
// In-flight budget multiplier per pool member. Two-times the pool size lets
// each underlying ioredis socket multiplex a small pipeline (1 command
// in-flight + 1 queued behind it) without letting the server-held request
// backlog grow unboundedly during a degraded window.
const INFLIGHT_PER_POOL_MEMBER = 2;

// Decide whether the URL bypasses the semaphore entirely. Exemption is
// URL-based (not route-config-based) because liveness/readiness probes and
// the active-target inspection endpoints must answer even if route
// registration accidentally regresses or fails to set `config.category`.
export function isExemptUrl(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  if (EXEMPT_EXACT.has(path)) return true;
  for (const p of EXEMPT_PREFIXES) if (path.startsWith(p)) return true;
  // SSE: server-sent-events endpoints hold connections open.
  if (path.endsWith("/stream")) return true;
  return false;
}

// Read the declared route category from Fastify's route config. Fastify
// populates `req.routeOptions.config` from the per-route `config: {...}`
// option at register-time, so preHandler hooks can see it before the
// handler body runs. Missing/invalid declarations return null so the
// caller can apply its own default.
export function readRouteCategory(req: FastifyRequest): RuntimeCategory | null {
  // `routeOptions.config` is typed by Fastify as an opaque per-route record;
  // we narrow via `unknown` so missing or wrongly-typed `category` values
  // fall through to the caller's default.
  const cfg = (req.routeOptions as { config?: unknown } | undefined)?.config;
  if (!cfg || typeof cfg !== "object") return null;
  const raw = (cfg as { category?: unknown }).category;
  if (raw === "heavy" || raw === "light") return raw;
  return null;
}

function readLimit(envKey: string, def: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

// Effective per-category default: `INFLIGHT_PER_POOL_MEMBER × pool size`.
// Pulling the pool size from active-target keeps the two dials in lockstep
// — operators only need to tune `RUNTIME_REDIS_POOL_SIZE_*` and the
// concurrency budget follows automatically.
function defaultLimit(category: RuntimeCategory): number {
  return INFLIGHT_PER_POOL_MEMBER * getRuntimePoolSize(category);
}

export interface BackpressureOpts {
  heavyLimit?: number;
  lightLimit?: number;
  retryAfterMs?: number;
  // Test seam — override the per-request classifier. Production wiring
  // reads from `req.routeOptions.config.category` (Wave 6.23 spec B1).
  classify?: (req: FastifyRequest) => Category;
}

export interface BackpressureState {
  heavy: number;
  light: number;
  heavyLimit: number;
  lightLimit: number;
}

// Symbol-keyed slot on the request so the onResponse/onRequestAbort hooks
// know whether the request was admitted (and which counter to decrement).
// Untyped-but-private; never serialised.
const SLOT = Symbol("frtb.backpressure.slot");

interface RequestWithSlot extends FastifyRequest {
  [SLOT]?: "heavy" | "light";
}

// Production classifier — exempt list first (URL-based safety net), then
// reads the declared category from `req.routeOptions.config.category`.
// Missing declarations default to "heavy" with a one-shot warn-per-URL so
// the unmigrated route is visible in logs without flooding under load.
function makeProductionClassify(
  warnedRoutes: Set<string>,
): (req: FastifyRequest) => Category {
  return (req) => {
    if (isExemptUrl(req.url)) return "exempt";
    const declared = readRouteCategory(req);
    if (declared) return declared;
    const url = req.url.split("?", 1)[0] ?? req.url;
    if (!warnedRoutes.has(url)) {
      warnedRoutes.add(url);
      req.log.warn(
        { route: url },
        "backpressure: missing route category, defaulting to heavy",
      );
    }
    return "heavy";
  };
}

export function registerBackpressure(app: FastifyInstance, opts: BackpressureOpts = {}): BackpressureState {
  // Pool-derived defaults keep the in-flight budget in lockstep with the
  // Wave 6.21 pool size. Env overrides (`MAX_INFLIGHT_HEAVY` /
  // `MAX_INFLIGHT_LIGHT`) still win, in case ops want to dial the request
  // budget independently of the connection pool.
  const heavyLimit = opts.heavyLimit ?? readLimit("MAX_INFLIGHT_HEAVY", defaultLimit("heavy"));
  const lightLimit = opts.lightLimit ?? readLimit("MAX_INFLIGHT_LIGHT", defaultLimit("light"));
  const retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const warnedRoutes = new Set<string>();
  const classify = opts.classify ?? makeProductionClassify(warnedRoutes);

  const state: BackpressureState = { heavy: 0, light: 0, heavyLimit, lightLimit };

  // preHandler (not onRequest) so `req.routeOptions.config` is populated
  // by the route-resolution step before we read the category.
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const cat = classify(req);
    if (cat === "exempt") return;
    const inflight = state[cat];
    const limit = cat === "heavy" ? heavyLimit : lightLimit;
    if (inflight >= limit) {
      req.log.warn(
        { route: req.url, category: cat, inflight, limit, status: 503 },
        "too-many-inflight: refusing request",
      );
      reply
        .header("Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)).toString())
        .code(503)
        .send({
          error: "too-many-inflight",
          category: cat,
          inflight,
          limit,
          retry_after_ms: retryAfterMs,
        });
      return reply;
    }
    state[cat] = inflight + 1;
    (req as RequestWithSlot)[SLOT] = cat;
  });

  const release = (req: FastifyRequest): void => {
    const r = req as RequestWithSlot;
    const cat = r[SLOT];
    if (cat === "heavy" || cat === "light") {
      state[cat] = Math.max(0, state[cat] - 1);
      r[SLOT] = undefined;
    }
  };

  app.addHook("onResponse", async (req) => { release(req); });
  // Fastify >=4 fires onRequestAbort when the client disconnects before
  // the response is sent; without this an aborted heavy request would
  // permanently consume a slot.
  app.addHook("onRequestAbort", async (req) => { release(req); });

  return state;
}
