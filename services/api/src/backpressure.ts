// Wave 6.23 — per-category in-flight concurrency limits.
//
// Two independent semaphores (heavy + light) gate route admission. Heavy
// routes (FCALL / FT.AGGREGATE — /calc, /pivot, /facets) share one budget so
// a UI navigation that fans out a dozen /calc calls cannot pile work onto
// the small Redis runtime pool faster than it drains. Light routes (Redis
// commands measured in microseconds — admin/observability/connections) get
// their own larger budget so heavy saturation does NOT starve them.
//
// Math: MAX_INFLIGHT_HEAVY = 2 × pool_size_heavy. Wave 6.21's heavy pool
// targets 4 members; 2× lets each connection multiplex a short pipeline
// (1 command in-flight + 1 queued behind it) but caps the server-held queue
// so a degraded session cannot accumulate unboundedly. Light defaults to 32
// (4× heavy) because per-request latency is sub-millisecond — the same
// concurrency budget would never saturate.
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

export type Category = "heavy" | "light" | "exempt";

const HEAVY_PREFIXES = ["/calc", "/pivot", "/facets"] as const;
const EXEMPT_EXACT = new Set(["/healthz", "/readyz"]);
const EXEMPT_PREFIXES = [
  "/redis/active-target",
  "/inflight",
  "/internal/redis/active-target",
] as const;

const DEFAULT_HEAVY = 8;
const DEFAULT_LIGHT = 32;
const DEFAULT_RETRY_AFTER_MS = 1000;

export function classifyRoute(url: string): Category {
  const path = url.split("?", 1)[0] ?? url;
  if (EXEMPT_EXACT.has(path)) return "exempt";
  for (const p of EXEMPT_PREFIXES) if (path.startsWith(p)) return "exempt";
  // SSE: server-sent-events endpoints hold connections open; gating them
  // would consume the budget without doing per-request Redis work.
  if (path.endsWith("/stream")) return "exempt";
  for (const p of HEAVY_PREFIXES) if (path.startsWith(p)) return "heavy";
  return "light";
}

function readLimit(envKey: string, def: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export interface BackpressureOpts {
  heavyLimit?: number;
  lightLimit?: number;
  retryAfterMs?: number;
  classify?: (url: string) => Category;
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

export function registerBackpressure(app: FastifyInstance, opts: BackpressureOpts = {}): BackpressureState {
  const heavyLimit = opts.heavyLimit ?? readLimit("MAX_INFLIGHT_HEAVY", DEFAULT_HEAVY);
  const lightLimit = opts.lightLimit ?? readLimit("MAX_INFLIGHT_LIGHT", DEFAULT_LIGHT);
  const retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const classify = opts.classify ?? classifyRoute;

  const state: BackpressureState = { heavy: 0, light: 0, heavyLimit, lightLimit };

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const cat = classify(req.url);
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
