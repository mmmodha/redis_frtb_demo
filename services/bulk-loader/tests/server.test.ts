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
  it("toggles accepting=true (idempotent) and returns 202", async () => {
    const res = await app.inject({ method: "POST", url: "/load/start" });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { accepted: boolean; accepting: boolean };
    expect(body.accepted).toBe(true);
    expect(body.accepting).toBe(true);
    // Idempotent — second call still succeeds.
    const res2 = await app.inject({ method: "POST", url: "/load/start" });
    expect(res2.statusCode).toBe(202);
  });
});

describe("POST /load/stop", () => {
  it("toggles accepting=false and returns 202", async () => {
    const res = await app.inject({ method: "POST", url: "/load/stop" });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { accepted: boolean; accepting: boolean };
    expect(body.accepted).toBe(true);
    expect(body.accepting).toBe(false);
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


describe("POST /load/rows — Wave 7.0.1.C", () => {
  async function buildWithDispatcher(opts: { highWater?: number; callDelayMs?: number; accepting?: boolean } = {}): Promise<{
    app: FastifyInstance;
    pool: WorkerPool;
    dispatcher: DispatcherHandle;
    clients: FakeWriteClient[];
  }> {
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
    if (opts.callDelayMs) {
      writeClients[0]!.callDelayMs = opts.callDelayMs;
      writeClients[1]!.callDelayMs = opts.callDelayMs;
    }
    const fakePool: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 2,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000,
      logger: { info: () => {} },
    });
    fakePool[0]!.becomeReady();
    fakePool[1]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients,
      batchSize: 1,
      idleFlushMs: 0,
      highWater: opts.highWater ?? 64,
    });
    const localApp = await createServer({ pool: localPool, dispatcher, accepting: opts.accepting });
    await localApp.ready();
    return { app: localApp, pool: localPool, dispatcher, clients: writeClients };
  }
  function makeRow(id: string): Row {
    return { id, risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1 } };
  }

  it("accepts a JSON-array body and enqueues every row (202)", async () => {
    const { app: a, pool: p, dispatcher: d } = await buildWithDispatcher();
    try {
      const res = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("a"), makeRow("b"), makeRow("c")]),
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { accepted: number };
      expect(body.accepted).toBe(3);
      await d.drain();
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("accepts an NDJSON body and enqueues every line (202)", async () => {
    const { app: a, pool: p, dispatcher: d, clients } = await buildWithDispatcher();
    try {
      const payload = [makeRow("x"), makeRow("y")].map((r) => JSON.stringify(r)).join("\n") + "\n";
      const res = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/x-ndjson" },
        payload,
      });
      expect(res.statusCode).toBe(202);
      expect((res.json() as { accepted: number }).accepted).toBe(2);
      await d.drain();
      const allHsets = clients.flatMap((c) => c.hsets.map((h) => h.key)).sort();
      expect(allHsets).toEqual(["sens:x", "sens:y"]);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("returns 429 when inFlight + rows would exceed highWater (producer-side backpressure)", async () => {
    // 200ms call delay keeps both flushes pending so inFlight stays pegged.
    const { app: a, pool: p, dispatcher: d } = await buildWithDispatcher({ highWater: 2, callDelayMs: 200 });
    try {
      // Saturate inFlight with two rows; both flushes are still pending
      // because of the 200 ms delay.
      const fill = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("a"), makeRow("b")]),
      });
      expect(fill.statusCode).toBe(202);
      expect(d.status().inFlight).toBe(2);
      // Next single-row request would push inFlight to 3 > highWater=2.
      const overflow = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("c")]),
      });
      expect(overflow.statusCode).toBe(429);
      const body = overflow.json() as { accepted: number; reason: string; in_flight: number; high_water: number };
      expect(body.accepted).toBe(0);
      expect(body.reason).toMatch(/high-water/);
      expect(body.high_water).toBe(2);
      expect(overflow.headers["retry-after"]).toBe("1");
      await d.drain();
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("returns 503 when not accepting; /load/start re-enables", async () => {
    const { app: a, pool: p, dispatcher: d } = await buildWithDispatcher({ accepting: false });
    try {
      const blocked = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("a")]),
      });
      expect(blocked.statusCode).toBe(503);
      await a.inject({ method: "POST", url: "/load/start" });
      const ok = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("a")]),
      });
      expect(ok.statusCode).toBe(202);
      await d.drain();
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("returns 400 on malformed body (wrong content-type)", async () => {
    const { app: a, pool: p, dispatcher: d } = await buildWithDispatcher();
    try {
      const res = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "text/plain" },
        payload: "not json",
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("returns 503 when no dispatcher is wired", async () => {
    // Pool-only server (no dispatcher) — represents a partially-booted
    // bulk-loader.
    const res = await app.inject({
      method: "POST", url: "/load/rows",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify([{ id: "x", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: 1 }]),
    });
    expect(res.statusCode).toBe(503);
  });
});
