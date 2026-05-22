import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

describe("GET /healthz", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 and { service: 'api', status: 'ok' }", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "api", status: "ok" });
  });
});

describe("GET /redis/active-target", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  afterEach(async () => {
    if (app) await app.close();
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
