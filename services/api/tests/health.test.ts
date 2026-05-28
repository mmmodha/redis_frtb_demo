import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  createServer,
  markBootstrapFailed,
  markBootstrapReady,
  markBootstrapSkipped,
  resetBootstrapStatusForTests,
} from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

describe("GET /healthz — bootstrap-gated (Wave 5.14b.1)", () => {
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
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "bootstrap-failed" });
  });

  it("(b) returns 200 + bootstrap:'ready' after markBootstrapReady()", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapReady();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "ok", bootstrap: "ready" });
  });

  it("(c) carries the error string through when bootstrap is marked failed", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapFailed(new Error("OOM command not allowed when used memory > 'maxmemory'"));
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("bootstrap-failed");
    expect(body.err).toContain("OOM command not allowed");
  });

  it("schema-missing skip surfaces reason on /healthz", async () => {
    app = await createServer({ redis: fakeRedis() });
    markBootstrapSkipped("schema-missing");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "bootstrap-failed", reason: "schema-missing" });
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
        host: "demo-cluster.hsbc",
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
      host: "demo-cluster.hsbc",
      port: 12000,
      tls: true,
      db: 0,
      label: "demo-cluster",
    });
    expect(body.password).toBeUndefined();
  });
});
