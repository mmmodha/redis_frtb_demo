import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, markBootstrapReady, resetBootstrapStatusForTests } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

// Wave 5.16g — @fastify/cors registration so the demo ui (nginx on
// http://localhost:3000) can call the api (http://localhost:8080) from a
// real browser. Pre-Wave 5.16g a preflight OPTIONS /connections returned
// 404 with no Access-Control-Allow-Origin header, surfacing as "Failed to
// fetch" in the browser console.
describe("CORS — @fastify/cors registration (Wave 5.16g)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    markBootstrapReady();
  });

  afterEach(async () => {
    if (app) await app.close();
    resetBootstrapStatusForTests();
  });

  it("preflight OPTIONS /connections from http://localhost:3000 is allowed with the expected methods", async () => {
    app = await createServer({
      redis: fakeRedis(),
      allowedOrigins: "http://localhost:3000",
      // Mount a no-op connections store so /connections is a real route.
      // The cors plugin handles OPTIONS preflight even for routes without
      // explicit OPTIONS handlers, so the store body is irrelevant here.
      store: {},
    });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/connections",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
      },
    });
    expect([200, 204]).toContain(res.statusCode);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const methods = String(res.headers["access-control-allow-methods"] ?? "");
    for (const m of ["GET", "POST", "PUT", "DELETE"]) {
      expect(methods).toContain(m);
    }
  });

  it("GET /healthz from http://localhost:3000 echoes access-control-allow-origin", async () => {
    app = await createServer({
      redis: fakeRedis(),
      allowedOrigins: "http://localhost:3000",
    });
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("rejects http://evil.example.com when the allow-list is restrictive", async () => {
    app = await createServer({
      redis: fakeRedis(),
      allowedOrigins: "http://localhost:3000",
    });
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://evil.example.com" },
    });
    // The handler still answers (CORS is a browser-side enforcement of
    // missing headers, not a server-side 4xx), but the ACAO header must
    // NOT echo the evil origin.
    expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });

  it("ALLOWED_ORIGINS=\"*\" echoes any origin (permissive local-dev mode)", async () => {
    app = await createServer({
      redis: fakeRedis(),
      allowedOrigins: "*",
    });
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://anywhere.example.com" },
    });
    expect(res.statusCode).toBe(200);
    // @fastify/cors with origin:true echoes the request origin back.
    expect(res.headers["access-control-allow-origin"]).toBe("http://anywhere.example.com");
  });

  it("comma-separated allow-list permits each listed origin", async () => {
    app = await createServer({
      redis: fakeRedis(),
      allowedOrigins: "http://localhost:3000, http://ui.demo.internal",
    });
    const a = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://ui.demo.internal" },
    });
    expect(a.statusCode).toBe(200);
    expect(a.headers["access-control-allow-origin"]).toBe("http://ui.demo.internal");

    const b = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://localhost:3000" },
    });
    expect(b.statusCode).toBe(200);
    expect(b.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});
