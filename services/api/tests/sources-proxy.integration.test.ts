// Wave 4.6 — integration test: exercise the api /sources/* proxy against
// the REAL @frtb/source Fastify service (not the http.createServer mock
// used in sources-proxy.test.ts). Confirms end-to-end:
//   1. proxy forwards GET /sources to upstream
//   2. proxy forwards GET /sources/:id including 404 status passthrough
//   3. proxy 502s when the upstream is unreachable (closed port)
//
// Uses the real source-service `createServer()` with an in-memory fake
// Redis + tmp upload dir; no Docker required.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createServer as createApiServer } from "../src/server.ts";
import { createServer as createSourceServer } from "../../source/src/server.ts";
import { createSourceStore } from "../../source/src/store.ts";
import { makeFakeRedis } from "../../source/tests/helpers/fake-redis.ts";
import { loadSchema } from "@frtb/schema";

const SCHEMA_PATH = join(__dirname, "..", "..", "..", "config", "schema", "frtb-default.yaml");

let api: FastifyInstance;
let source: FastifyInstance;
let sourceBase: string;
let uploadDir: string;

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "src-proxy-int-"));
  const redis = makeFakeRedis();
  const store = createSourceStore({ redis });
  // Seed one source so the proxied GET has something to find.
  await store.create({
    name: "demo.csv",
    format: "csv",
    origin: "upload",
    path: join(uploadDir, "demo.csv"),
    size_bytes: 1024,
  });
  source = await createSourceServer({
    redis,
    store,
    schema: loadSchema(SCHEMA_PATH),
    uploadDir,
    logger: false,
  });
  await source.listen({ host: "127.0.0.1", port: 0 });
  const addr = source.server.address();
  if (!addr || typeof addr === "string") throw new Error("source listen failed");
  sourceBase = `http://127.0.0.1:${addr.port}`;

  api = await createApiServer({ sourceBase });
  await api.ready();
});

afterAll(async () => {
  if (api) await api.close();
  if (source) await source.close();
  if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
});

describe("api /sources/* proxy against the real @frtb/source service", () => {
  it("forwards GET /sources and returns the live list from the source-service", async () => {
    const res = await api.inject({ method: "GET", url: "/sources" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("demo.csv");
    expect(body[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("forwards GET /sources/:id and passes through a 404 from the upstream", async () => {
    const res = await api.inject({ method: "GET", url: "/sources/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 502 when the upstream source-service is unreachable", async () => {
    // Close the upstream and re-issue: proxy must surface a 502, not 500.
    await source.close();
    const res = await api.inject({ method: "GET", url: "/sources" });
    expect(res.statusCode).toBe(502);
  });
});
