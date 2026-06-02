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
