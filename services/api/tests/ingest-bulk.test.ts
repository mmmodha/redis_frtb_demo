// Wave 7.0.6.15 — POST /ingest/bulk/start workers field + cancel surface.
//
// Exercises the request validation + response shape: workers defaults to 1
// (single-worker bit-equivalent path), is clamped against the host-cores
// override exposed via the test seam, and is echoed back in the 202 body
// alongside the existing batch_size / concurrency. The cancel endpoint is
// covered for the unknown-id (404) and missing-id (400) branches; a full
// in-flight cancel requires worker_threads + a real schema and is left to
// the operator smoke run documented in the wave spec.

import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { loadSchema, type Schema } from "@frtb/schema";
import { registerIngestRoutes, _testResetBulkRuns, _testGetBulkRun } from "../src/routes/ingest.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function loadFixtureSchema(): Schema {
  return loadSchema(
    resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"),
  );
}

// Build a Fastify app with only the ingest routes wired. Mock fetch swallows
// the bulk-loader POSTs so the inline workers=1 path can complete without a
// live :8086 server. The `availableCores` seam pins the host-cores cap so
// the clamp branch is deterministic across CI hosts.
function mountIngest(schema: Schema | undefined, cores = 8): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    // server.ts attaches this via the rate-limit plugin; the routes read
    // it for the pool-category hint, so a no-op default keeps the routes
    // happy under direct mounting.
    (req as unknown as { poolCategory: string }).poolCategory = "light";
  });
  registerIngestRoutes(app, schema, {
    bulkLoaderBase: "http://127.0.0.1:1",
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    availableCores: () => cores,
  });
  return app;
}

describe("POST /ingest/bulk/start — workers field", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
    _testResetBulkRuns();
  });

  it("defaults workers to 1 and echoes it in the 202 response", async () => {
    app = mountIngest(loadFixtureSchema(), 8);
    const res = await app.inject({
      method: "POST",
      url: "/ingest/bulk/start",
      payload: { rows: 10 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.workers).toBe(1);
    expect(typeof body.run_id).toBe("string");
    expect(body.rows_total).toBe(10);
  });

  it("clamps workers to availableCores()", async () => {
    app = mountIngest(loadFixtureSchema(), 4);
    const res = await app.inject({
      method: "POST",
      url: "/ingest/bulk/start",
      // Request more workers than the host advertises; route must clamp.
      payload: { rows: 10, workers: 16 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().workers).toBe(4);
  });

  it("returns 503 when schema is not loaded", async () => {
    app = mountIngest(undefined, 8);
    const res = await app.inject({
      method: "POST",
      url: "/ingest/bulk/start",
      payload: { rows: 10 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/schema/i);
  });

  it("rejects non-positive rows with 400", async () => {
    app = mountIngest(loadFixtureSchema(), 8);
    const res = await app.inject({
      method: "POST",
      url: "/ingest/bulk/start",
      payload: { rows: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /ingest/bulk/cancel", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
    _testResetBulkRuns();
  });

  it("returns 400 when run_id is missing", async () => {
    app = mountIngest(loadFixtureSchema(), 8);
    const res = await app.inject({ method: "POST", url: "/ingest/bulk/cancel", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown run id", async () => {
    app = mountIngest(loadFixtureSchema(), 8);
    const res = await app.inject({
      method: "POST",
      url: "/ingest/bulk/cancel",
      payload: { run_id: "missing" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("accepts cancel against a known run id (200 or 409 once terminal)", async () => {
    app = mountIngest(loadFixtureSchema(), 8);
    const start = await app.inject({
      method: "POST",
      url: "/ingest/bulk/start",
      payload: { rows: 10, workers: 1 },
    });
    const run_id = start.json().run_id as string;
    const res = await app.inject({
      method: "POST",
      url: "/ingest/bulk/cancel",
      payload: { run_id },
    });
    // The inline loop completes in microseconds against the mock fetch, so
    // by the time the cancel arrives the run may be terminal (409) or
    // still running (200). Both responses prove the route resolved the
    // id; what we don't want is a 404/5xx.
    expect([200, 409]).toContain(res.statusCode);
    expect(_testGetBulkRun(run_id)).toBeDefined();
  });
});
