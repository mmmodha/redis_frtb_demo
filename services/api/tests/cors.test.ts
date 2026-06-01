import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { loadSchema, type Schema } from "@frtb/schema";
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

// Wave 5.21i — routes that call `reply.hijack()` bypass @fastify/cors's
// onSend hook, so the actual response went out without
// access-control-allow-origin and the browser blocked it (visible as a
// "Failed to fetch" red banner on the Synthetic Generator card). The fix
// merges a hand-rolled CORS header into each writeHead. Tests below pin the
// header on every hijacked surface.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function loadFixtureSchema(): Schema {
  return loadSchema(
    resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"),
  );
}

interface PipelineFakeRedis extends ReturnType<typeof fakeRedis> {
  pipeline(): {
    xadd(stream: string, id: string, ...fields: string[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]>>;
  };
}
function pipelineFakeRedis(): PipelineFakeRedis {
  const base = fakeRedis() as PipelineFakeRedis;
  base.pipeline = () => {
    const buffered: unknown[] = [];
    return {
      xadd(_stream: string, _id: string, ..._fields: string[]) {
        buffered.push(null);
        return this;
      },
      async exec() {
        return buffered.map(() => [null, "0-0"] as [Error | null, unknown]);
      },
    };
  };
  return base;
}

async function startMockProxyUpstream(): Promise<{ app: FastifyInstance; base: string }> {
  const app = Fastify({ logger: false });
  app.get("/sources", async () => [{ id: "src-01" }]);
  app.get("/loadgen/status", async () => ({ running: false, total_requests: 0 }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return { app, base: `http://127.0.0.1:${addr.port}` };
}

describe("CORS — hijacked SSE + proxy responses carry access-control-allow-origin (Wave 5.21i)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let upstream: { app: FastifyInstance; base: string } | undefined;

  beforeEach(() => {
    markBootstrapReady();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (upstream) { await upstream.app.close(); upstream = undefined; }
    resetBootstrapStatusForTests();
  });

  it("GET /inflight/stream echoes access-control-allow-origin + vary: Origin", async () => {
    app = await createServer({
      redis: fakeRedis(),
      allowedOrigins: "http://localhost:3000",
    });
    const res = await app.inject({
      method: "GET",
      url: "/inflight/stream",
      headers: { origin: "http://localhost:3000", accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(res.headers["vary"] ?? "")).toMatch(/Origin/);
    (res.stream() as unknown as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  });

  it("POST /generator/start/stream echoes access-control-allow-origin + vary: Origin", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({
      redis: pipelineFakeRedis(),
      schema,
      allowedOrigins: "http://localhost:3000",
    });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 1 },
      headers: {
        origin: "http://localhost:3000",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(res.headers["vary"] ?? "")).toMatch(/Origin/);
    (res.stream() as unknown as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  });

  it("GET /observability/shards/stream echoes access-control-allow-origin + vary: Origin", async () => {
    app = await createServer({
      redis: fakeRedis(),
      allowedOrigins: "http://localhost:3000",
      sseIntervalMs: 50,
    });
    const res = await app.inject({
      method: "GET",
      url: "/observability/shards/stream",
      headers: { origin: "http://localhost:3000", accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(res.headers["vary"] ?? "")).toMatch(/Origin/);
    (res.stream() as unknown as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  });

  it("GET /sources (proxy) echoes access-control-allow-origin + vary: Origin", async () => {
    upstream = await startMockProxyUpstream();
    app = await createServer({
      sourceBase: upstream.base,
      allowedOrigins: "http://localhost:3000",
    });
    const res = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(res.headers["vary"] ?? "")).toMatch(/Origin/);
  });

  it("GET /loadgen/status (proxy) echoes access-control-allow-origin + vary: Origin", async () => {
    upstream = await startMockProxyUpstream();
    app = await createServer({
      loadgenBase: upstream.base,
      allowedOrigins: "http://localhost:3000",
    });
    const res = await app.inject({
      method: "GET",
      url: "/loadgen/status",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(res.headers["vary"] ?? "")).toMatch(/Origin/);
  });
});
