// Wave 5.38c — POST /admin/flush. Wipes the active Redis target via FLUSHDB
// and returns timing for the UI banner. 503 when no active target is set.
//
// Wave 5.46 — extended assertions for the post-flush bootstrap: the route now
// also rebuilds idx:sens + the frtb library and surfaces the outcome under
// `bootstrap: { ok, error? }` so the UI can render "indexes rebuilt".

import { describe, it, expect, afterEach, vi } from "vitest";
import type { Schema } from "@frtb/schema";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { resetActiveTarget } from "../src/active-target.ts";

// Minimal stub — the route only forwards the schema to the (mocked)
// bootstrap runner, so the real shape is irrelevant inside these unit tests.
const stubSchema = {} as Schema;

describe("POST /admin/flush", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
  });

  it("calls flushdb exactly once and returns ok + ms + target_label", async () => {
    const fr = fakeRedis();
    // No schema wired → bootstrap short-circuits to the schema-missing branch
    // (asserted in its own test below); the flush + timing surface stays the
    // same so the existing assertions hold.
    app = await createServer({
      redis: fr,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" },
    });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ms).toBe("number");
    expect(body.ms).toBeGreaterThanOrEqual(0);
    expect(body.target_label).toBe("redis-primary");

    const flushCalls = fr.calls.filter((c) => c.command === "FLUSHDB");
    expect(flushCalls).toHaveLength(1);
  });

  it("returns 503 when active target has no label", async () => {
    const fr = fakeRedis();
    app = await createServer({
      redis: fr,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "" },
    });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "no active target" });
    expect(fr.calls.find((c) => c.command === "FLUSHDB")).toBeUndefined();
  });

  it("surfaces translated redis errors (412 for missing index/library)", async () => {
    const fr = fakeRedis();
    fr.setFlushdbError(new Error("Unknown Index name"));
    app = await createServer({
      redis: fr,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" },
    });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(412);
    expect(res.json().target_label).toBe("redis-primary");
  });

  // Wave 5.46 — new assertions for the post-flush bootstrap branch.
  //
  // createServer ignores any unknown opts so the bootstrap-runner injection
  // can't be threaded through there. Build the server normally, then swap
  // the admin route registration by re-registering it on a fresh app via a
  // direct call — but the route is registered before listen, so the cleanest
  // path is to re-import registerAdminRoutes onto a Fastify instance we own.
  // Keeping the existing createServer-based pattern: we exercise the
  // bootstrap-injection seam by importing registerAdminRoutes directly here.

  it("calls bootstrap with the active redis client and returns bootstrap.ok=true on success", async () => {
    const fr = fakeRedis();
    const runBootstrap = vi.fn(async () => ({ index: { nodes: 1 } }));
    // Build a minimal Fastify around the same fake redis and inject the
    // bootstrap runner via the admin-routes opts (Wave 5.46 seam).
    const Fastify = (await import("fastify")).default;
    const { registerAdminRoutes } = await import("../src/routes/admin.ts");
    const { setActiveTarget } = await import("../src/active-target.ts");
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" });
    app = Fastify();
    registerAdminRoutes(app, () => fr, { schema: stubSchema, bootstrap: runBootstrap });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, target_label: "redis-primary", bootstrap: { ok: true } });
    expect(typeof body.ms).toBe("number");
    expect(runBootstrap).toHaveBeenCalledTimes(1);
    // The redis client passed to bootstrap must be the same instance the
    // route just FLUSHDB'd against.
    expect(runBootstrap.mock.calls[0]![0]).toBe(fr);
    expect(runBootstrap.mock.calls[0]![1]).toBe(stubSchema);
  });

  it("returns bootstrap.ok=false with the thrown error message when bootstrap throws", async () => {
    const fr = fakeRedis();
    const runBootstrap = vi.fn(async () => { throw new Error("FT.CREATE failed"); });
    const Fastify = (await import("fastify")).default;
    const { registerAdminRoutes } = await import("../src/routes/admin.ts");
    const { setActiveTarget } = await import("../src/active-target.ts");
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" });
    app = Fastify();
    registerAdminRoutes(app, () => fr, { schema: stubSchema, bootstrap: runBootstrap });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.target_label).toBe("redis-primary");
    expect(body.bootstrap).toEqual({ ok: false, error: "FT.CREATE failed" });
    expect(runBootstrap).toHaveBeenCalledTimes(1);
  });

  // Wave 5.86C — POST /admin/flush invalidates the /facets in-process cache
  // so the UI sees post-flush row counts immediately. Without this the
  // identity-keyed 30 s cache (Wave 5.67) would serve the pre-flush body for
  // up to TTL, requiring `?nocache=true` as a workaround.
  it("invalidates the /facets cache so a subsequent GET /facets reflects post-flush state immediately", async () => {
    function aggReply(rows: Array<Record<string, string | number>>) {
      const out: unknown[] = [rows.length];
      for (const r of rows) {
        const flat: unknown[] = [];
        for (const [k, v] of Object.entries(r)) flat.push(k, String(v));
        out.push(flat);
      }
      return out;
    }
    const cursorReply = (rows: Array<Record<string, string | number>>, cursorId: number) =>
      [aggReply(rows), cursorId];

    const fr = fakeRedis();
    let nextAgg: unknown = cursorReply(
      [{ risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", n: 10 }],
      0,
    );
    fr.setResponse("FT.AGGREGATE", () => nextAgg);

    const runBootstrap = vi.fn(async () => ({}));
    const Fastify = (await import("fastify")).default;
    const { registerAdminRoutes } = await import("../src/routes/admin.ts");
    const { registerFacetsRoute, __resetFacetsCacheForTests } = await import(
      "../src/routes/facets.ts"
    );
    const { setActiveTarget } = await import("../src/active-target.ts");
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" });
    __resetFacetsCacheForTests();
    app = Fastify();
    registerAdminRoutes(app, () => fr, { schema: stubSchema, bootstrap: runBootstrap });
    registerFacetsRoute(app, () => fr);

    // Prime the facets cache with the pre-flush body.
    const r1 = await app.inject({ method: "GET", url: "/facets" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ cached: false, total_rows: 10, risk_class: { GIRR: 10 } });
    const r1Cached = await app.inject({ method: "GET", url: "/facets" });
    expect(r1Cached.json().cached).toBe(true);

    // Swap the FT.AGGREGATE response to simulate the post-flush index state.
    nextAgg = cursorReply(
      [{ risk_class: "FX", bucket: "EUR", sensitivity_type: "Vega", n: 7 }],
      0,
    );

    const flushRes = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(flushRes.statusCode).toBe(200);
    const flushBody = flushRes.json();
    expect(flushBody.bootstrap).toMatchObject({ ok: true, cache_invalidated: true });

    // /facets without ?nocache must drain a fresh aggregate, not serve the
    // stale pre-flush body that was cached above.
    const r2 = await app.inject({ method: "GET", url: "/facets" });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ cached: false, total_rows: 7, risk_class: { FX: 7 } });
  });

  it("returns bootstrap.ok=false with error 'schema-missing' when no schema is wired", async () => {
    const fr = fakeRedis();
    const runBootstrap = vi.fn();
    const Fastify = (await import("fastify")).default;
    const { registerAdminRoutes } = await import("../src/routes/admin.ts");
    const { setActiveTarget } = await import("../src/active-target.ts");
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" });
    app = Fastify();
    registerAdminRoutes(app, () => fr, { bootstrap: runBootstrap });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.target_label).toBe("redis-primary");
    expect(body.bootstrap).toEqual({ ok: false, error: "schema-missing" });
    // FLUSHDB still ran exactly once even though bootstrap was skipped.
    expect(fr.calls.filter((c) => c.command === "FLUSHDB")).toHaveLength(1);
    expect(runBootstrap).not.toHaveBeenCalled();
  });
});
