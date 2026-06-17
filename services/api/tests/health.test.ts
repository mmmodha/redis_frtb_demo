import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  createServer,
  markBootstrapFailed,
  markBootstrapReady,
  markBootstrapSkipped,
  resetBootstrapStatusForTests,
} from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

describe("GET /healthz — liveness (Wave 5.97D.1)", () => {
  // Wave 5.97D.1 split /healthz from /readyz. /healthz is now process-up
  // liveness only — it MUST answer 200 in every bootstrap phase so the
  // compose healthcheck (process-alive) passes before any Redis is wired,
  // unblocking the fresh-clone `docker compose up -d --wait` happy path.
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    resetBootstrapStatusForTests();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetBootstrapStatusForTests();
  });

  it("returns 200 + alive body before bootstrap completes (initial)", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "alive" });
  });

  it("returns 200 + alive body after markBootstrapReady()", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapReady();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "alive" });
  });

  it("returns 200 + alive body when bootstrap is marked failed", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapFailed(new Error("OOM command not allowed when used memory > 'maxmemory'"));
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "alive" });
  });

  it("returns 200 + alive body when bootstrap is skipped (schema-missing)", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapSkipped("schema-missing");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "alive" });
  });

  it("returns 200 + alive body when bootstrap is skipped (redis-unreachable)", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapSkipped("redis-unreachable");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "alive" });
  });
});

describe("GET /readyz — bootstrap-gated (formerly /healthz, Wave 5.14b.1)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    resetBootstrapStatusForTests();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetBootstrapStatusForTests();
  });

  it("(a) returns 503 + bootstrap-failed body before bootstrap completes", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "bootstrap-failed" });
  });

  it("(b) returns 200 + bootstrap:'ready' after markBootstrapReady()", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapReady();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "ok", bootstrap: "ready" });
  });

  it("(c) carries the error string through when bootstrap is marked failed", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapFailed(new Error("OOM command not allowed when used memory > 'maxmemory'"));
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("bootstrap-failed");
    expect(body.err).toContain("OOM command not allowed");
  });

  it("schema-missing skip surfaces reason on /readyz", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapSkipped("schema-missing");
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "bootstrap-failed", reason: "schema-missing" });
  });
});

// Wave 6.26 — /readyz must ALSO refuse to flip green until the runtime
// pool's sockets are writable. Pre-6.26 the boot-protection client was the
// only gate; the runtime pool is built lazily (lazyConnect + offlineQueue
// off) so the first 3-5 calls after a restart raced the TLS handshake and
// surfaced `ReplyError: Stream isn't writeable`. The probe runs a cheap
// PING per slot, cached 250ms; /readyz returns 503 with
// `runtime-pool-not-ready` until every probe resolves ok.
describe("GET /readyz — runtime-pool readiness probe (Wave 6.26)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    resetBootstrapStatusForTests();
    markBootstrapReady();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetBootstrapStatusForTests();
  });

  it("returns 503 + runtime-pool-not-ready when the probe rejects (even with bootstrap ready)", async () => {
    app = await createServer({
      readinessProbe: async () => ({ ok: false, err: "Stream isn't writeable" }),
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("runtime-pool-not-ready");
    expect(body.err).toContain("Stream isn't writeable");
  });

  it("returns 200 once the runtime probe resolves ok", async () => {
    app = await createServer({
      readinessProbe: async () => ({ ok: true }),
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "ok", bootstrap: "ready" });
  });

  it("still surfaces bootstrap-failed before reaching the runtime probe (probe must not run when boot isn't ok)", async () => {
    let probeCalled = false;
    resetBootstrapStatusForTests();
    app = await createServer({
      readinessProbe: async () => { probeCalled = true; return { ok: true }; },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "bootstrap-failed" });
    expect(probeCalled).toBe(false);
  });

  it("skips the runtime probe when opts.redis (fake redis) is wired so the legacy contract holds", async () => {
    // opts.redis means the routes use a fake Redis, not the real runtime
    // pool — pinging the real pool would talk to a Redis the test isn't
    // running. The /readyz gate must therefore be boot-status-only when
    // a fake is injected. Regression guard for the existing health.test
    // suite invariants (b)/(c)/(d).
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "ok", bootstrap: "ready" });
  });
});

describe("GET /redis/active-target", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    // /redis/active-target doesn't read the flag, but mark ready so the rest
    // of the suite's tests aren't accidentally blocked by 503s in future
    // expansions of this describe block.
    markBootstrapReady();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetBootstrapStatusForTests();
  });

  it("returns the active target with no password", async () => {
    app = await createServer({
      redis: fakeRedis(),
      activeTarget: {
        host: "demo-cluster.bank",
        port: 12000,
        tls: true,
        db: 0,
        label: "demo-cluster",
      },
    });
    const res = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      host: "demo-cluster.bank",
      port: 12000,
      tls: true,
      db: 0,
      label: "demo-cluster",
    });
    expect(body.password).toBeUndefined();
  });
});
