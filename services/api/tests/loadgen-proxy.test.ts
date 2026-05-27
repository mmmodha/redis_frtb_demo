// RED — api proxy tests for /loadgen/*.
//
// Mirrors the sources-proxy pattern: a real Fastify "loadgen mock" is bound to
// a random port; we exercise the api proxy over real HTTP and assert (a) bodies
// pass through verbatim, (b) status codes propagate, (c) the SSE stream is
// forwarded as text/event-stream with `data: …\n\n` framing intact, and (d)
// upstream connect/transport failures surface as 502.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer } from "../src/server.ts";

interface UpstreamCall {
  method: string;
  url: string;
  body?: unknown;
}

interface MockUpstream {
  app: FastifyInstance;
  base: string;
  calls: UpstreamCall[];
  setMode(mode: "ok" | "5xx"): void;
}

async function startMockLoadgen(): Promise<MockUpstream> {
  const app = Fastify({ logger: false });
  const calls: UpstreamCall[] = [];
  let mode: "ok" | "5xx" = "ok";

  app.get("/healthz", async () => ({ service: "loadgen", status: "ok" }));

  app.post<{ Body: unknown }>("/loadgen/start", async (req, reply) => {
    calls.push({ method: "POST", url: "/loadgen/start", body: req.body });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    reply.code(202);
    return { running: true, config: { concurrency: 200, mix: { pivot: 0.5, calc: 0.5 }, duration_sec: 60 } };
  });

  app.post("/loadgen/stop", async (req, reply) => {
    calls.push({ method: "POST", url: "/loadgen/stop" });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    return { stopped: true };
  });

  app.get("/loadgen/status", async (req, reply) => {
    calls.push({ method: "GET", url: "/loadgen/status" });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    return { running: false, total_requests: 0 };
  });

  // SSE handler: write 2 frames then end.
  app.get("/loadgen/metrics", async (req, reply) => {
    calls.push({ method: "GET", url: "/loadgen/metrics" });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const frame = (n: number): string =>
      `data: ${JSON.stringify({ ts: n, throughput_rps: 0, latency: { p50: 0, p95: 0, p99: 0 }, errors: 0, total_requests: 0, per_endpoint: { pivot: { count: 0, errors: 0, p50: 0, p95: 0, p99: 0 }, calc: { count: 0, errors: 0, p50: 0, p95: 0, p99: 0 } }, running: false, elapsed_sec: 0 })}\n\n`;
    reply.raw.write(frame(1));
    reply.raw.write(frame(2));
    reply.raw.end();
    return reply;
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    app,
    base: `http://127.0.0.1:${addr.port}`,
    calls,
    setMode: (m) => { mode = m; },
  };
}

let upstream: MockUpstream;
let api: FastifyInstance;

beforeAll(async () => {
  upstream = await startMockLoadgen();
  api = await createServer({ loadgenBase: upstream.base });
});

afterAll(async () => {
  await api.close();
  await upstream.app.close();
});

beforeEach(() => {
  upstream.calls.length = 0;
  upstream.setMode("ok");
});

describe("loadgen-proxy: route surface", () => {
  it("POST /loadgen/start forwards JSON body + 202 status verbatim", async () => {
    const res = await api.inject({
      method: "POST",
      url: "/loadgen/start",
      payload: { concurrency: 50, duration_sec: 30 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().running).toBe(true);
    const last = upstream.calls.at(-1)!;
    expect(last.url).toBe("/loadgen/start");
    expect(last.body).toEqual({ concurrency: 50, duration_sec: 30 });
  });

  it("POST /loadgen/stop forwards and returns the 200 status", async () => {
    const res = await api.inject({ method: "POST", url: "/loadgen/stop" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true });
  });

  it("GET /loadgen/status forwards verbatim", async () => {
    const res = await api.inject({ method: "GET", url: "/loadgen/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ running: false, total_requests: 0 });
  });
});

describe("loadgen-proxy: SSE forwarding", () => {
  it("GET /loadgen/metrics forwards as text/event-stream with intact data frames", async () => {
    const res = await api.inject({ method: "GET", url: "/loadgen/metrics" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/text\/event-stream/);
    expect(res.body).toMatch(/^data: /m);
    const frames = res.body.split("\n\n").filter((s) => s.length > 0);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(frames[0]!.replace(/^data: /, ""));
    expect(first).toMatchObject({ ts: 1, running: false });
  });
});

describe("loadgen-proxy: upstream failure handling", () => {
  it("returns 502 with a documented JSON shape when upstream is unreachable", async () => {
    const stranded = await createServer({ loadgenBase: "http://127.0.0.1:1" });
    try {
      const res = await stranded.inject({ method: "GET", url: "/loadgen/status" });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: "loadgen service unreachable" });
    } finally {
      await stranded.close();
    }
  });

  it("returns 502 when upstream replies 5xx", async () => {
    upstream.setMode("5xx");
    const res = await api.inject({ method: "GET", url: "/loadgen/status" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "loadgen service unreachable" });
  });
});
