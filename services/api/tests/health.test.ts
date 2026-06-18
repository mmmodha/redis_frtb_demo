import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  createServer,
  markBootstrapFailed,
  markBootstrapReady,
  markBootstrapSkipped,
  resetBootstrapStatusForTests,
} from "../src/server.ts";
import {
  __resetRuntimeReadinessCacheForTests,
  __setRuntimeClientFactoryForTests,
  probeRuntimeRedisReadiness,
  resetActiveTarget,
  setActiveTarget,
} from "../src/active-target.ts";
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
    // Wave 6.26 — regression tests below install a runtime client factory
    // and set an active target; tear both down so they don't leak across
    // cases.
    __setRuntimeClientFactoryForTests(null);
    resetActiveTarget();
    __resetRuntimeReadinessCacheForTests();
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

  // Regression for the original 6.26 bug: index.ts always wires
  // `opts.getRedis` (the production lazy accessor). The first probe-gate
  // version skipped the runtime probe whenever EITHER `opts.redis` or
  // `opts.getRedis` was set, so in production the probe was never invoked
  // and /readyz flipped green before the runtime pool sockets were
  // writable — reproducing the exact 500-storm the gate was meant to
  // prevent. This test wires only `opts.getRedis` (no `opts.readinessProbe`
  // override), installs a runtime client factory whose `ping()` rejects,
  // and asserts /readyz returns 503/runtime-pool-not-ready — proving the
  // production code path DOES run the probe.
  it("does NOT skip the runtime probe when opts.getRedis (production accessor) is wired", async () => {
    // Install a fake runtime client whose ping() rejects with the exact
    // ioredis error the cold-start race surfaces in production.
    const failingPing = vi.fn(() => Promise.reject(new Error("Stream isn't writeable")));
    __setRuntimeClientFactoryForTests(() => ({
      options: { commandTimeout: 0, host: "fake", db: 0 },
      on(): unknown { return this; },
      disconnect(): void { /* no-op */ },
      ping: failingPing,
    } as unknown as import("ioredis").Redis));
    // Set an active target so the pool builds slots on first acquisition.
    setActiveTarget({ host: "fake.example.com", port: 6379, tls: false, db: 0, label: "fake" });
    __resetRuntimeReadinessCacheForTests();

    app = await createServer({
      // Production-style accessor; does not gate the probe.
      getRedis: () => ({} as unknown as import("../src/redis-like.ts").RedisLike),
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("runtime-pool-not-ready");
    expect(body.err).toContain("Stream isn't writeable");
    expect(failingPing).toHaveBeenCalled();
  });

  it("returns 200 once the runtime probe succeeds when opts.getRedis is wired (production accessor)", async () => {
    // Companion to the above: same production-style wiring, but the
    // runtime client's ping() resolves — /readyz must flip green.
    __setRuntimeClientFactoryForTests(() => ({
      options: { commandTimeout: 0, host: "fake", db: 0 },
      on(): unknown { return this; },
      disconnect(): void { /* no-op */ },
      ping: () => Promise.resolve("PONG"),
    } as unknown as import("ioredis").Redis));
    setActiveTarget({ host: "fake.example.com", port: 6379, tls: false, db: 0, label: "fake" });
    __resetRuntimeReadinessCacheForTests();

    app = await createServer({
      getRedis: () => ({} as unknown as import("../src/redis-like.ts").RedisLike),
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "ok", bootstrap: "ready" });
  });
});

// Wave 6.36.A — regression guard for the warm-restart latency contract.
// Pre-fix, the probe walked pool members serially and called `ping()` while
// the underlying socket was still in `connecting`/`reconnecting`, fast-
// failing under Wave 6.23's `enableOfflineQueue:false` + the 250ms failure
// cache — pushing /readyz first-200 to ~2.8s. The fix is two-part:
//   1. Wait for each member's `'ready'` event (or `connect()` from `wait`)
//      before issuing PING.
//   2. Parallelise the per-member check via `Promise.all` so 8 sockets
//      establish concurrently instead of 8×RTT.
// These tests pin both invariants without standing up a real Redis.
describe("probeRuntimeRedisReadiness — warm-restart latency (Wave 6.36.A)", () => {
  beforeEach(() => {
    __resetRuntimeReadinessCacheForTests();
  });
  afterEach(() => {
    __setRuntimeClientFactoryForTests(null);
    resetActiveTarget();
    __resetRuntimeReadinessCacheForTests();
  });

  // Each fake client reports `status: "wait"` and a `connect()` that resolves
  // after `connectDelayMs`. `ping()` resolves only AFTER connect — if the
  // probe were to fire PING before awaiting connect, ping would reject
  // with the same "Stream isn't writeable" error production saw.
  function slowConnectClient(connectDelayMs: number): import("ioredis").Redis {
    let connected = false;
    const fake = {
      status: "wait" as string,
      options: { commandTimeout: 0, host: "fake", db: 0 },
      on(): unknown { return this; },
      once(): unknown { return this; },
      off(): unknown { return this; },
      disconnect(): void { /* no-op */ },
      connect(): Promise<void> {
        return new Promise((resolve) => setTimeout(() => {
          connected = true;
          fake.status = "ready";
          resolve();
        }, connectDelayMs));
      },
      ping(): Promise<string> {
        return connected
          ? Promise.resolve("PONG")
          : Promise.reject(new Error("Stream isn't writeable"));
      },
    };
    return fake as unknown as import("ioredis").Redis;
  }

  it("waits for each member's connect to complete before pinging (no Stream-isn't-writeable race)", async () => {
    __setRuntimeClientFactoryForTests(() => slowConnectClient(20));
    setActiveTarget({ host: "fake", port: 6379, tls: false, db: 0, label: "fake" });
    const verdict = await probeRuntimeRedisReadiness();
    expect(verdict).toEqual({ ok: true });
  });

  it("parallelises member checks (total time ≈ max per-member, not sum)", async () => {
    // 8 members × 50ms each. Serial → ~400ms; parallel → ~50ms.
    // Assert <200ms to leave headroom for CI variance while still catching
    // a regression to the serial loop.
    __setRuntimeClientFactoryForTests(() => slowConnectClient(50));
    setActiveTarget({ host: "fake", port: 6379, tls: false, db: 0, label: "fake" });
    const t0 = performance.now();
    const verdict = await probeRuntimeRedisReadiness();
    const elapsed = performance.now() - t0;
    expect(verdict).toEqual({ ok: true });
    expect(elapsed).toBeLessThan(200);
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
