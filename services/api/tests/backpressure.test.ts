// Wave 6.23 — per-category in-flight concurrency limits.
//
// Verifies:
//   1. heavy semaphore admits up to MAX_INFLIGHT_HEAVY; next request → 503
//   2. heavy saturation does NOT block light routes
//   3. 503 payload carries error/category/inflight/limit/retry_after_ms +
//      a Retry-After header
//   4. releasing a slot (request completes) admits the next request
//   5. exempt routes (/healthz) bypass the gate entirely
//   6. category resolved from `config.category` (route-level, not URL sniffing)
//   7. routes missing `config.category` default to heavy + log a warning
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerBackpressure, isExemptUrl, readRouteCategory } from "../src/backpressure.ts";

interface Holder { resolve: () => void }

function buildApp(opts: { heavyLimit?: number; lightLimit?: number; retryAfterMs?: number } = {}): {
  app: FastifyInstance;
  heavyHolders: Holder[];
  lightHolders: Holder[];
} {
  const app = Fastify();
  registerBackpressure(app, {
    heavyLimit: opts.heavyLimit ?? 8,
    lightLimit: opts.lightLimit ?? 32,
    retryAfterMs: opts.retryAfterMs ?? 1000,
  });
  const heavyHolders: Holder[] = [];
  const lightHolders: Holder[] = [];
  // Wave 6.23 B1 — classification is driven by `config.category`, not URL.
  app.get("/calc/sbm", { config: { category: "heavy" } }, async () => {
    await new Promise<void>((resolve) => { heavyHolders.push({ resolve }); });
    return { ok: true };
  });
  app.get("/admin/preflight", { config: { category: "light" } }, async () => {
    await new Promise<void>((resolve) => { lightHolders.push({ resolve }); });
    return { ok: true };
  });
  app.get("/healthz", async () => ({ status: "alive" }));
  return { app, heavyHolders, lightHolders };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

describe("Wave 6.23 — concurrency limits + 503 too-many-inflight", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });

  it("admits up to MAX_INFLIGHT_HEAVY concurrent heavy requests; rejects the next with 503", async () => {
    const built = buildApp({ heavyLimit: 8 });
    app = built.app;
    await app.ready();

    const pending = Array.from({ length: 8 }, () => app!.inject({ method: "GET", url: "/calc/sbm" }));
    await tick();
    expect(built.heavyHolders.length).toBe(8);

    const res = await app.inject({ method: "GET", url: "/calc/sbm" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("too-many-inflight");
    expect(body.category).toBe("heavy");
    expect(body.inflight).toBe(8);
    expect(body.limit).toBe(8);
    expect(typeof body.retry_after_ms).toBe("number");
    expect(body.retry_after_ms).toBeGreaterThan(0);
    expect(res.headers["retry-after"]).toBe("1");

    for (const h of built.heavyHolders) h.resolve();
    await Promise.all(pending);
  });

  it("heavy saturation does NOT block light requests", async () => {
    const built = buildApp({ heavyLimit: 2, lightLimit: 4 });
    app = built.app;
    await app.ready();

    const heavyPending = [
      app.inject({ method: "GET", url: "/calc/sbm" }),
      app.inject({ method: "GET", url: "/calc/sbm" }),
    ];
    await tick();
    const heavyReject = await app.inject({ method: "GET", url: "/calc/sbm" });
    expect(heavyReject.statusCode).toBe(503);

    // Light routes must still be admitted while heavy is fully saturated.
    const lightPending = app.inject({ method: "GET", url: "/admin/preflight" });
    await tick();
    expect(built.lightHolders.length).toBe(1);
    built.lightHolders[0]?.resolve();
    const lightRes = await lightPending;
    expect(lightRes.statusCode).toBe(200);

    for (const h of built.heavyHolders) h.resolve();
    await Promise.all(heavyPending);
  });

  it("releasing a slot admits the next request (semaphore decrement on response)", async () => {
    const built = buildApp({ heavyLimit: 2 });
    app = built.app;
    await app.ready();

    const p1 = app.inject({ method: "GET", url: "/calc/sbm" });
    const p2 = app.inject({ method: "GET", url: "/calc/sbm" });
    await tick();
    const reject = await app.inject({ method: "GET", url: "/calc/sbm" });
    expect(reject.statusCode).toBe(503);

    // Complete one in-flight request, freeing a slot.
    built.heavyHolders[0]?.resolve();
    const r1 = await p1;
    expect(r1.statusCode).toBe(200);

    // A new request must now be admitted.
    const p3 = app.inject({ method: "GET", url: "/calc/sbm" });
    await tick();
    expect(built.heavyHolders.length).toBe(3);
    built.heavyHolders[1]?.resolve();
    built.heavyHolders[2]?.resolve();
    await Promise.all([p2, p3]);
  });

  it("exempt routes (/healthz) bypass the gate even when heavy is saturated", async () => {
    const built = buildApp({ heavyLimit: 1 });
    app = built.app;
    await app.ready();
    const p = app.inject({ method: "GET", url: "/calc/sbm" });
    await tick();
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    built.heavyHolders[0]?.resolve();
    await p;
  });

  it("isExemptUrl: liveness/readiness, /redis/active-target, /inflight, SSE", () => {
    expect(isExemptUrl("/healthz")).toBe(true);
    expect(isExemptUrl("/readyz")).toBe(true);
    expect(isExemptUrl("/redis/active-target")).toBe(true);
    expect(isExemptUrl("/redis/active-target/bootstrap-status")).toBe(true);
    expect(isExemptUrl("/internal/redis/active-target")).toBe(true);
    expect(isExemptUrl("/inflight")).toBe(true);
    expect(isExemptUrl("/inflight/stream")).toBe(true);
    expect(isExemptUrl("/observability/shards/stream")).toBe(true);
    // Non-exempt: classified by route config at admission time.
    expect(isExemptUrl("/calc/sbm")).toBe(false);
    expect(isExemptUrl("/admin/preflight")).toBe(false);
    expect(isExemptUrl("/observability/keys")).toBe(false);
  });

  it("readRouteCategory: reads from req.routeOptions.config.category", async () => {
    const app2 = Fastify();
    let seenHeavy: ReturnType<typeof readRouteCategory> | undefined;
    let seenLight: ReturnType<typeof readRouteCategory> | undefined;
    let seenUndeclared: ReturnType<typeof readRouteCategory> | undefined;
    app2.addHook("preHandler", async (req) => {
      if (req.url === "/h") seenHeavy = readRouteCategory(req);
      else if (req.url === "/l") seenLight = readRouteCategory(req);
      else if (req.url === "/u") seenUndeclared = readRouteCategory(req);
    });
    app2.get("/h", { config: { category: "heavy" } }, async () => ({ ok: true }));
    app2.get("/l", { config: { category: "light" } }, async () => ({ ok: true }));
    app2.get("/u", async () => ({ ok: true }));
    try {
      await app2.inject({ method: "GET", url: "/h" });
      await app2.inject({ method: "GET", url: "/l" });
      await app2.inject({ method: "GET", url: "/u" });
      expect(seenHeavy).toBe("heavy");
      expect(seenLight).toBe("light");
      expect(seenUndeclared).toBeNull();
    } finally {
      await app2.close();
    }
  });

  it("routes missing config.category default to heavy and consume the heavy budget", async () => {
    const app2 = Fastify();
    registerBackpressure(app2, { heavyLimit: 1, lightLimit: 32 });
    const holders: Holder[] = [];
    // No `config.category` on this route — must default to heavy.
    app2.get("/legacy", async () => {
      await new Promise<void>((resolve) => { holders.push({ resolve }); });
      return { ok: true };
    });
    try {
      await app2.ready();
      const p1 = app2.inject({ method: "GET", url: "/legacy" });
      await new Promise((r) => setImmediate(r));
      // Heavy budget is 1 — second concurrent request must be rejected.
      const reject = await app2.inject({ method: "GET", url: "/legacy" });
      expect(reject.statusCode).toBe(503);
      expect(reject.json().category).toBe("heavy");
      holders[0]?.resolve();
      await p1;
    } finally {
      await app2.close();
    }
  });
});
