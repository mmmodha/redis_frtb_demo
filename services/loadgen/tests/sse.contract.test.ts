// RED — SSE contract for the loadgen HTTP surface.
//
// The api proxies /loadgen/* through to this server; the UI's LoadgenPanel
// subscribes to /loadgen/metrics via EventSource. This test pins the wire
// shape so regressions break loudly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/server.ts";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer({
    apiBase: "http://127.0.0.1:1",
    fetch: async () => new Response("{}", { status: 200 }),
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.inject({ method: "POST", url: "/loadgen/stop" });
});

describe("GET /healthz", () => {
  it("returns 200 ok with service identifier", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "loadgen", status: "ok" });
  });
});

describe("GET /loadgen/metrics — Server-Sent Events contract", () => {
  it("responds with text/event-stream content-type", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/loadgen/metrics?frames=1",
      headers: { accept: "text/event-stream" },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/text\/event-stream/);
  });

  it("emits one snapshot frame matching the documented shape (frames=1)", async () => {
    const res = await app.inject({ method: "GET", url: "/loadgen/metrics?frames=1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/^data: /m);
    const m = res.body.match(/^data: (.+)$/m);
    expect(m).not.toBeNull();
    const obj = JSON.parse(m![1]!);
    expect(obj).toMatchObject({
      ts: expect.any(Number),
      throughput_rps: expect.any(Number),
      latency: {
        p50: expect.any(Number),
        p95: expect.any(Number),
        p99: expect.any(Number),
      },
      errors: expect.any(Number),
      total_requests: expect.any(Number),
      per_endpoint: {
        pivot: {
          count: expect.any(Number),
          errors: expect.any(Number),
          p50: expect.any(Number),
          p95: expect.any(Number),
          p99: expect.any(Number),
        },
        calc: {
          count: expect.any(Number),
          errors: expect.any(Number),
          p50: expect.any(Number),
          p95: expect.any(Number),
          p99: expect.any(Number),
        },
      },
      running: expect.any(Boolean),
      elapsed_sec: expect.any(Number),
    });
  });

  it("ends each frame with a blank line per SSE spec (\\n\\n)", async () => {
    const res = await app.inject({ method: "GET", url: "/loadgen/metrics?frames=1" });
    expect(res.body).toMatch(/\n\n$/);
  });
});

describe("POST /loadgen/start", () => {
  it("returns 202 with running=true and echoes the config", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/loadgen/start",
      payload: { concurrency: 4, duration_sec: 60, mix: { pivot: 0.7, calc: 0.3 } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.running).toBe(true);
    expect(body.config.concurrency).toBe(4);
    expect(body.config.duration_sec).toBe(60);
    expect(body.config.mix).toEqual({ pivot: 0.7, calc: 0.3 });
  });

  it("defaults concurrency to 200 when not specified", async () => {
    const res = await app.inject({ method: "POST", url: "/loadgen/start", payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().config.concurrency).toBe(200);
  });

  it("defaults mix to a 50/50 pivot+calc split when not specified", async () => {
    const res = await app.inject({ method: "POST", url: "/loadgen/start", payload: {} });
    expect(res.json().config.mix).toEqual({ pivot: 0.5, calc: 0.5 });
  });
});

describe("POST /loadgen/stop", () => {
  it("returns 200 with stopped=true and flips status to not-running", async () => {
    await app.inject({ method: "POST", url: "/loadgen/start", payload: { concurrency: 1, duration_sec: 60 } });
    const stop = await app.inject({ method: "POST", url: "/loadgen/stop" });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().stopped).toBe(true);
    const status = await app.inject({ method: "GET", url: "/loadgen/status" });
    expect(status.json().running).toBe(false);
  });
});

// Wave 5.14b.2: pins the SSE route registration so a future rename or accidental
// removal of /loadgen/metrics breaks loudly. The smoke-run-6 author hit
// /loadgen/metrics/stream and saw 404 — that path was never registered; the
// real SSE route is /loadgen/metrics.
describe("route table — SSE registration snapshot", () => {
  it("registers GET /loadgen/metrics (the SSE route) and does not register the wrong-path variants", () => {
    const tree = app.printRoutes({ commonPrefix: false });
    expect(tree).toMatch(/\/loadgen\/metrics\s+\(GET/);
    expect(tree).not.toContain("/loadgen/metrics/stream");
    expect(tree).not.toContain("/loadgen/stream");
    expect(tree).not.toContain("/loadgen/events");
  });

  it("returns 404 (not 5xx) for the stale /loadgen/metrics/stream path so consumers fail loudly", async () => {
    const res = await app.inject({ method: "GET", url: "/loadgen/metrics/stream" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /loadgen/status", () => {
  it("reports the current runner snapshot inline (running flag + config)", async () => {
    await app.inject({ method: "POST", url: "/loadgen/start", payload: { concurrency: 3, duration_sec: 60 } });
    const res = await app.inject({ method: "GET", url: "/loadgen/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.running).toBe(true);
    expect(body.config.concurrency).toBe(3);
  });
});
