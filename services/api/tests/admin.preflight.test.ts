// Wave 5.47b — GET /admin/preflight and POST /admin/rebuild-indexes.
//
// Pre-flight probes idx:sens (per master), FUNCTION LIST for the frtb library,
// and EXISTS sensitivities:in; rebuild calls bootstrapFrtb. Mirrors the
// admin.test.ts seam pattern: build Fastify directly so we can inject a
// fakeRedis and a bootstrap stub.

import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import { registerAdminRoutes } from "../src/routes/admin.ts";
import {
  setActiveTarget,
  resetActiveTarget,
} from "../src/active-target.ts";
import { fakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";

const stubSchema = {} as Schema;

function primeHealthy(fr: FakeRedis): void {
  fr.setResponse("FT.INFO", ["index_name", "idx:sens"]);
  fr.setResponse("FUNCTION", [
    ["library_name", "frtb", "engine", "LUA", "functions", []],
  ]);
  fr.setResponse("EXISTS", 1);
  fr.setResponse("PING", "PONG");
}

function makeApp(fr: FakeRedis, opts?: { schema?: Schema; bootstrap?: ReturnType<typeof vi.fn> }): FastifyInstance {
  setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" });
  const app = Fastify();
  registerAdminRoutes(app, () => fr, {
    schema: opts?.schema,
    bootstrap: opts?.bootstrap as never,
  });
  return app;
}

describe("GET /admin/preflight (Wave 5.47b)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    resetActiveTarget();
  });

  it("returns ok=true with all three checks passing when the stack is healthy", async () => {
    const fr = fakeRedis();
    primeHealthy(fr);
    app = makeApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/preflight" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.idx_sens).toEqual({ ok: true, missing: [] });
    expect(body.checks.frtb_library).toEqual({ ok: true, loaded: true });
    expect(body.checks.stream).toEqual({ ok: true, exists: true });
    expect(body.can_rebuild).toBe(false);
  });

  it("returns ok=false with idx_sens.missing populated when FT.INFO throws", async () => {
    const fr = fakeRedis();
    primeHealthy(fr);
    fr.setResponse("FT.INFO", () => { throw new Error("Unknown Index name"); });
    app = makeApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/preflight" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.idx_sens.ok).toBe(false);
    expect(body.checks.idx_sens.missing).toEqual(["node-0"]);
    expect(body.can_rebuild).toBe(true);
  });

  it("reports frtb_library.loaded=false when FUNCTION LIST has no 'frtb' entry", async () => {
    const fr = fakeRedis();
    primeHealthy(fr);
    fr.setResponse("FUNCTION", [
      ["library_name", "other", "engine", "LUA", "functions", []],
    ]);
    app = makeApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/preflight" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.frtb_library).toEqual({ ok: false, loaded: false });
    expect(body.can_rebuild).toBe(true);
  });

  it("reports stream.exists=false when EXISTS returns 0", async () => {
    const fr = fakeRedis();
    primeHealthy(fr);
    fr.setResponse("EXISTS", 0);
    app = makeApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/preflight" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.stream).toEqual({ ok: false, exists: false });
    expect(body.can_rebuild).toBe(true);
  });

  it("sets can_rebuild=false when PING fails even if other checks failed", async () => {
    const fr = fakeRedis();
    primeHealthy(fr);
    fr.setResponse("EXISTS", 0);
    fr.setResponse("PING", () => { throw new Error("connection refused"); });
    app = makeApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/preflight" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.can_rebuild).toBe(false);
  });
});

describe("POST /admin/rebuild-indexes (Wave 5.47b)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    resetActiveTarget();
  });

  it("calls bootstrap and returns ok=true with timing", async () => {
    const fr = fakeRedis();
    const runBootstrap = vi.fn(async () => ({ index: { nodes: 1 } }));
    app = makeApp(fr, { schema: stubSchema, bootstrap: runBootstrap });
    const res = await app.inject({
      method: "POST", url: "/admin/rebuild-indexes",
      headers: { "content-type": "application/json" }, payload: "{}",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.bootstrap).toEqual({ ok: true });
    expect(typeof body.ms).toBe("number");
    expect(runBootstrap).toHaveBeenCalledTimes(1);
    expect(runBootstrap.mock.calls[0]![0]).toBe(fr);
    expect(runBootstrap.mock.calls[0]![1]).toBe(stubSchema);
  });

  it("is idempotent — a second invocation re-runs bootstrap and still returns ok=true", async () => {
    const fr = fakeRedis();
    const runBootstrap = vi.fn(async () => ({ index: { nodes: 1 } }));
    app = makeApp(fr, { schema: stubSchema, bootstrap: runBootstrap });
    await app.inject({ method: "POST", url: "/admin/rebuild-indexes", headers: { "content-type": "application/json" }, payload: "{}" });
    const res = await app.inject({ method: "POST", url: "/admin/rebuild-indexes", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.json().ok).toBe(true);
    expect(runBootstrap).toHaveBeenCalledTimes(2);
  });

  it("returns bootstrap.ok=false with the thrown message when bootstrap throws", async () => {
    const fr = fakeRedis();
    const runBootstrap = vi.fn(async () => { throw new Error("FT.CREATE failed"); });
    app = makeApp(fr, { schema: stubSchema, bootstrap: runBootstrap });
    const res = await app.inject({ method: "POST", url: "/admin/rebuild-indexes", headers: { "content-type": "application/json" }, payload: "{}" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.bootstrap).toEqual({ ok: false, error: "FT.CREATE failed" });
  });

  it("returns bootstrap.ok=false error 'schema-missing' when no schema wired", async () => {
    const fr = fakeRedis();
    app = makeApp(fr);
    const res = await app.inject({ method: "POST", url: "/admin/rebuild-indexes", headers: { "content-type": "application/json" }, payload: "{}" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.bootstrap).toEqual({ ok: false, error: "schema-missing" });
  });
});
