// Wave 7.0.1.A — bulk-loader HTTP surface tests.
//
// Covers the Definition-of-Done items:
//   • /healthz returns 200 when ≥75% connected, 503 otherwise.
//   • /load/status reports pool_size, connected, per-worker heartbeat fields.
//   • /load/start is wired but stubbed (503 until 7.0.1.B).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { createWorkerPool, type WorkerPool } from "../src/pool.ts";
import { createDispatcher, type DispatcherHandle, type Row } from "../src/dispatcher.ts";
import { FakeClient } from "./helpers/fake-client.ts";
import { FakeWriteClient } from "./helpers/fake-write-client.ts";
import type { FastifyInstance } from "fastify";

let pool: WorkerPool;
let clients: FakeClient[];
let app: FastifyInstance;

function buildPool(size: number): void {
  clients = [];
  pool = createWorkerPool({
    size,
    redisFactory: () => { const c = new FakeClient(); clients.push(c); return c; },
    heartbeatMs: 60_000,
    logger: { info: () => {} },
  });
}

beforeEach(async () => {
  buildPool(4);
  app = await createServer({ pool });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await pool.stop();
});

describe("GET /healthz", () => {
  it("returns 503 with no workers connected (degraded)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { service: string; status: string; connected: number; pool_size: number };
    expect(body.service).toBe("bulk-loader");
    expect(body.status).toBe("degraded");
    expect(body.connected).toBe(0);
    expect(body.pool_size).toBe(4);
  });

  it("returns 200 with 3 of 4 workers connected (75% threshold)", async () => {
    clients[0]!.becomeReady();
    clients[1]!.becomeReady();
    clients[2]!.becomeReady();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; connected: number; pool_size: number };
    expect(body.status).toBe("ok");
    expect(body.connected).toBe(3);
    expect(body.pool_size).toBe(4);
  });

  it("returns 503 at 50% (2 of 4)", async () => {
    clients[0]!.becomeReady();
    clients[1]!.becomeReady();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
  });
});

describe("GET /load/status", () => {
  it("reports pool_size, connected, and per-worker state shape", async () => {
    clients[0]!.becomeReady();
    const res = await app.inject({ method: "GET", url: "/load/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pool_size: number;
      connected: number;
      workers: Array<{ id: number; state: string; last_heartbeat: number | null; last_flush_at: number | null }>;
    };
    expect(body.pool_size).toBe(4);
    expect(body.connected).toBe(1);
    expect(body.workers).toHaveLength(4);
    expect(body.workers[0]?.id).toBe(0);
    expect(body.workers[0]?.state).toBe("connected");
    expect(body.workers[0]?.last_flush_at).toBeNull();
    expect(body.workers[1]?.state).toBe("connecting");
  });
});

describe("POST /load/start", () => {
  it("returns 503 stub until row producer wiring lands in 7.0.1.C", async () => {
    const res = await app.inject({ method: "POST", url: "/load/start" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { accepted: boolean; reason: string };
    expect(body.accepted).toBe(false);
    expect(body.reason).toMatch(/7\.0\.1\.C/);
  });
});

describe("GET /load/status — with dispatcher wired", () => {
  it("merges dispatcher per-worker metrics + inFlight/highWater into the response", async () => {
    // Build a fresh pool + dispatcher pair for this test so the merge path
    // exercises real per-worker WriteMetrics rather than the null defaults.
    await app.close();
    await pool.stop();
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
    const fakePoolClients: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 2,
      redisFactory: () => { const c = new FakeClient(); fakePoolClients.push(c); return c; },
      heartbeatMs: 60_000,
      logger: { info: () => {} },
    });
    fakePoolClients[0]!.becomeReady();
    fakePoolClients[1]!.becomeReady();
    const dispatcher: DispatcherHandle = createDispatcher({
      workerClients: writeClients,
      batchSize: 1,
      idleFlushMs: 0,
      highWater: 64,
    });
    const r: Row = {
      id: "u1", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
      risk_value: { "3M": 0.1 },
    };
    await dispatcher.enqueue(r);
    await dispatcher.drain();

    const localApp = await createServer({ pool: localPool, dispatcher });
    try {
      const res = await localApp.inject({ method: "GET", url: "/load/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        dispatcher: { in_flight: number; high_water: number } | null;
        workers: Array<{
          id: number; queued: number | null; flushed: number | null;
          errors: number | null; dead_lettered: number | null;
          last_flush_latency_ms: number | null; last_flush_at: number | null;
        }>;
      };
      expect(body.dispatcher).not.toBeNull();
      expect(body.dispatcher!.in_flight).toBe(0);
      expect(body.dispatcher!.high_water).toBe(64);
      expect(body.workers[0]!.queued).toBe(1);
      expect(body.workers[0]!.flushed).toBe(1);
      expect(body.workers[0]!.errors).toBe(0);
      expect(body.workers[0]!.dead_lettered).toBe(0);
      expect(body.workers[0]!.last_flush_at).not.toBeNull();
      expect(body.workers[1]!.queued).toBe(0);
    } finally {
      await localApp.close();
      await dispatcher.stop();
      await localPool.stop();
    }
    // Re-init the outer fixtures so afterEach's close/stop calls are safe.
    buildPool(4);
    app = await createServer({ pool });
    await app.ready();
  });
});
