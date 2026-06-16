// Wave 6.12a — api proxy tests for /ingest/shards + /ingest/status.
//
// Mirrors the loadgen-proxy / sources-proxy patterns: a real Fastify "ingest
// mock" is bound to a random port; we exercise the api proxy over real HTTP
// and assert (a) bodies pass through verbatim, (b) status codes propagate
// (incl. 400 / 409 from the shard-control endpoint), and (c) upstream
// connect/transport failures surface as 502 with the documented JSON shape.

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
  setMode(mode: "ok" | "5xx" | "400" | "409"): void;
}

async function startMockIngest(): Promise<MockUpstream> {
  const app = Fastify({ logger: false });
  const calls: UpstreamCall[] = [];
  let mode: "ok" | "5xx" | "400" | "409" = "ok";

  app.get("/ingest/shards", async (req, reply) => {
    calls.push({ method: "GET", url: "/ingest/shards" });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    return { totalShards: 1, assignment: [0], streams: ["sensitivities:in"] };
  });

  app.post<{ Body: unknown }>("/ingest/shards", async (req, reply) => {
    calls.push({ method: "POST", url: "/ingest/shards", body: req.body });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    if (mode === "400") { reply.code(400); return { error: "invalid body" }; }
    if (mode === "409") { reply.code(409); return { error: "rebuild already in progress" }; }
    const body = req.body as { totalShards?: number } | undefined;
    const total = body?.totalShards ?? 1;
    return {
      totalShards: total,
      assignment: Array.from({ length: total }, (_, i) => i),
      streams: total === 1
        ? ["sensitivities:in"]
        : Array.from({ length: total }, (_, i) => `sensitivities:in:{${i}}`),
    };
  });

  app.get("/ingest/status", async (req, reply) => {
    calls.push({ method: "GET", url: "/ingest/status" });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    return {
      totalShards: 1, assignment: [0], streams: ["sensitivities:in"],
      consumed: 42, errors: 0, ready: true,
    };
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
  upstream = await startMockIngest();
  api = await createServer({ ingestBase: upstream.base });
});

afterAll(async () => {
  await api.close();
  await upstream.app.close();
});

beforeEach(() => {
  upstream.calls.length = 0;
  upstream.setMode("ok");
});

describe("ingest-shards proxy: route surface", () => {
  it("GET /ingest/shards forwards verbatim", async () => {
    const res = await api.inject({ method: "GET", url: "/ingest/shards" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ totalShards: 1, assignment: [0], streams: ["sensitivities:in"] });
    expect(upstream.calls.at(-1)?.url).toBe("/ingest/shards");
  });

  it("POST /ingest/shards forwards JSON body and the new snapshot", async () => {
    const res = await api.inject({
      method: "POST",
      url: "/ingest/shards",
      payload: { totalShards: 4 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { totalShards: number; streams: string[] };
    expect(body.totalShards).toBe(4);
    expect(body.streams).toEqual([
      "sensitivities:in:{0}", "sensitivities:in:{1}",
      "sensitivities:in:{2}", "sensitivities:in:{3}",
    ]);
    expect(upstream.calls.at(-1)?.body).toEqual({ totalShards: 4 });
  });

  it("GET /ingest/status forwards including consumed / errors / ready", async () => {
    const res = await api.inject({ method: "GET", url: "/ingest/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ consumed: 42, errors: 0, ready: true });
  });
});

describe("ingest-shards proxy: status propagation", () => {
  it("propagates 400 from the upstream (invalid POST body)", async () => {
    upstream.setMode("400");
    const res = await api.inject({ method: "POST", url: "/ingest/shards", payload: { bad: true } });
    expect(res.statusCode).toBe(400);
  });

  it("propagates 409 from the upstream (rebuild in flight)", async () => {
    upstream.setMode("409");
    const res = await api.inject({ method: "POST", url: "/ingest/shards", payload: { totalShards: 4 } });
    expect(res.statusCode).toBe(409);
  });
});

describe("ingest-shards proxy: upstream failure handling", () => {
  it("returns 502 with the documented JSON shape when upstream is unreachable", async () => {
    const stranded = await createServer({ ingestBase: "http://127.0.0.1:1" });
    try {
      const res = await stranded.inject({ method: "GET", url: "/ingest/shards" });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: "ingest service unreachable" });
    } finally {
      await stranded.close();
    }
  });

  it("returns 502 when upstream replies 5xx", async () => {
    upstream.setMode("5xx");
    const res = await api.inject({ method: "GET", url: "/ingest/shards" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "ingest service unreachable" });
  });
});
