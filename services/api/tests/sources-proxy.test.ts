// Wave 3.5C — proxy tests for the api /sources/* routes.
//
// A real Fastify "source service" mock is bound to a random port so we can
// exercise the proxy over real HTTP and assert: (a) request/response bodies
// pass through verbatim, (b) status codes are forwarded, (c) multipart upload
// bodies stream through (not buffered), and (d) upstream 5xx/connect errors
// surface as 502 with the documented JSON shape.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.ts";

interface UpstreamCall {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  bodyBytes?: number;
  bodyText?: string;
}

interface MockUpstream {
  app: FastifyInstance;
  base: string;
  calls: UpstreamCall[];
  setMode(mode: "ok" | "5xx" | "close"): void;
}

async function startMockSource(): Promise<MockUpstream> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 256 * 1024 * 1024 } });
  const calls: UpstreamCall[] = [];
  let mode: "ok" | "5xx" | "close" = "ok";

  app.addHook("onRequest", async (req) => {
    if (mode === "5xx") return;
    if (mode === "close") {
      req.raw.socket.destroy();
    }
  });

  app.get("/healthz", async () => ({ service: "source", status: "ok" }));

  app.get("/sources", async () => {
    calls.push({ method: "GET", url: "/sources", headers: {} });
    if (mode === "5xx") throw new Error("boom");
    return [{ id: "src-01", name: "demo.csv" }];
  });

  app.get<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    calls.push({ method: "GET", url: `/sources/${req.params.id}`, headers: {} });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    if (req.params.id === "missing") { reply.code(404); return { error: "not found" }; }
    return { id: req.params.id, status: "uploaded" };
  });

  app.delete<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    calls.push({ method: "DELETE", url: `/sources/${req.params.id}`, headers: {} });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    reply.code(204);
    return null;
  });

  app.post("/sources/upload", async (req, reply) => {
    const file = await req.file();
    if (!file) { reply.code(400); return { error: "no file" }; }
    const chunks: Buffer[] = [];
    for await (const c of file.file) chunks.push(c as Buffer);
    const total = chunks.reduce((n, b) => n + b.length, 0);
    calls.push({
      method: "POST",
      url: "/sources/upload",
      headers: { "content-type": req.headers["content-type"] },
      bodyBytes: total,
    });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    reply.code(201);
    return { id: "src-uploaded", name: file.filename, size_bytes: total };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/sources/:id/infer", async (req, reply) => {
    calls.push({ method: "POST", url: `/sources/${req.params.id}/infer`, headers: {}, body: req.body });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    return { source: { id: req.params.id }, columns: [], mapping_suggestion: { fields: {} } };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/sources/:id/mapping", async (req, reply) => {
    calls.push({ method: "POST", url: `/sources/${req.params.id}/mapping`, headers: {}, body: req.body });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    return { id: req.params.id, status: "mapped" };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/sources/:id/ingest", async (req, reply) => {
    calls.push({ method: "POST", url: `/sources/${req.params.id}/ingest`, headers: {}, body: req.body });
    if (mode === "5xx") { reply.code(500); return { error: "upstream" }; }
    reply.code(202);
    return { source_id: req.params.id, status: "ingesting" };
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, base, calls, setMode: (m) => { mode = m; } };
}

function buildMultipart(field: string, filename: string, body: Buffer | string): { body: Buffer; contentType: string } {
  const boundary = `----frtb-test-${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `Content-Type: text/csv\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = typeof body === "string" ? Buffer.from(body) : body;
  return { body: Buffer.concat([head, payload, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

let upstream: MockUpstream;
let api: FastifyInstance;

beforeAll(async () => {
  upstream = await startMockSource();
  api = await createServer({ sourceBase: upstream.base });
});

afterAll(async () => {
  await api.close();
  await upstream.app.close();
});

beforeEach(() => {
  upstream.calls.length = 0;
  upstream.setMode("ok");
});

describe("sources-proxy: route surface", () => {
  it("GET /sources/healthz probes the upstream /healthz", async () => {
    const res = await api.inject({ method: "GET", url: "/sources/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "source", status: "ok" });
  });

  it("GET /sources forwards verbatim", async () => {
    const res = await api.inject({ method: "GET", url: "/sources" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: "src-01", name: "demo.csv" }]);
    expect(upstream.calls.some((c) => c.method === "GET" && c.url === "/sources")).toBe(true);
  });

  it("GET /sources/:id forwards verbatim incl. 404 status", async () => {
    const ok = await api.inject({ method: "GET", url: "/sources/src-01" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: "src-01", status: "uploaded" });
    const notFound = await api.inject({ method: "GET", url: "/sources/missing" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: "not found" });
  });

  it("DELETE /sources/:id forwards verbatim incl. 204 no-body", async () => {
    const res = await api.inject({ method: "DELETE", url: "/sources/src-01" });
    expect(res.statusCode).toBe(204);
  });

  it("POST /sources/:id/infer forwards JSON body verbatim", async () => {
    const res = await api.inject({
      method: "POST",
      url: "/sources/src-01/infer",
      payload: { sample_limit: 1000 },
    });
    expect(res.statusCode).toBe(200);
    const last = upstream.calls.at(-1)!;
    expect(last.url).toBe("/sources/src-01/infer");
    expect(last.body).toEqual({ sample_limit: 1000 });
  });

  it("POST /sources/:id/mapping forwards JSON body verbatim", async () => {
    const mapping = { mapping: { fields: { risk_class: { column: "rc" } } } };
    const res = await api.inject({
      method: "POST",
      url: "/sources/src-01/mapping",
      payload: mapping,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "src-01", status: "mapped" });
    const last = upstream.calls.at(-1)!;
    expect(last.body).toEqual(mapping);
  });

  it("POST /sources/:id/ingest forwards and returns the 202 status", async () => {
    const res = await api.inject({ method: "POST", url: "/sources/src-01/ingest" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ source_id: "src-01", status: "ingesting" });
  });
});

describe("sources-proxy: multipart upload streaming", () => {
  it("POST /sources/upload streams a small multipart body through to upstream", async () => {
    const { body, contentType } = buildMultipart("file", "tiny.csv", "risk_class,bucket\nGIRR,USD-IRS\n");
    const res = await api.inject({
      method: "POST",
      url: "/sources/upload",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.id).toBe("src-uploaded");
    expect(json.name).toBe("tiny.csv");
    const last = upstream.calls.at(-1)!;
    expect(last.url).toBe("/sources/upload");
    expect(typeof last.bodyBytes).toBe("number");
    expect(last.bodyBytes).toBeGreaterThan(0);
  });

  it("POST /sources/upload streams a 5MB body through without buffering the whole file", async () => {
    // 5MB CSV-shaped payload — proves the proxy doesn't choke on demo-scale uploads.
    // The DoD calls for request.raw.pipe; presence is asserted separately below.
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41); // 'A' x 5 MiB
    const { body, contentType } = buildMultipart("file", "big.csv", big);
    const res = await api.inject({
      method: "POST",
      url: "/sources/upload",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const last = upstream.calls.at(-1)!;
    expect(last.bodyBytes).toBe(big.length);
  });

  it("proxy implementation uses request.raw.pipe (no buffering)", () => {
    // Structural check matching the DoD: "confirm with request.raw.pipe in implementation".
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../src/routes/sources-proxy.ts"), "utf8");
    expect(src).toMatch(/req(uest)?\.raw\.pipe/);
  });
});

describe("sources-proxy: upstream failure handling", () => {
  it("returns 502 with documented JSON when upstream is unreachable", async () => {
    const stranded = await createServer({ sourceBase: "http://127.0.0.1:1" });
    try {
      const res = await stranded.inject({ method: "GET", url: "/sources" });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: "source service unreachable" });
    } finally {
      await stranded.close();
    }
  });

  it("returns 502 with documented JSON when upstream replies 5xx", async () => {
    upstream.setMode("5xx");
    const res = await api.inject({ method: "GET", url: "/sources" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "source service unreachable" });
  });
});
