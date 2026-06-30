// Wave 7.0.1.A — bulk-loader HTTP surface tests.
//
// Covers the Definition-of-Done items:
//   • /healthz returns 200 when ≥75% connected, 503 otherwise.
//   • /load/status reports pool_size, connected, per-worker heartbeat fields.
//   • /load/start is wired but stubbed (503 until 7.0.1.B).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, BULK_LOADER_INSTANCE_ID } from "../src/server.ts";
import { createWorkerPool, type WorkerPool } from "../src/pool.ts";
import { createDispatcher, type DispatcherHandle, type Row } from "../src/dispatcher.ts";
import {
  createBulkLoaderState,
  updateApiActiveTarget,
  type BulkLoaderState,
} from "../src/swap-target.ts";
import { fetchActiveTargetIdentity } from "../src/active-target-identity.ts";
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
  it("returns 200 awaiting when no pool is wired (UI-first bootstrap)", async () => {
    const awaiting = createBulkLoaderState({
      pool: null,
      dispatcher: null,
      checkpointer: null,
      bootstrapCheckpoints: new Map(),
      boundTarget: null,
      boundVersion: null,
      targetWatcher: "awaiting",
    });
    const awaitingApp = await createServer({ state: awaiting });
    await awaitingApp.ready();
    const res = await awaitingApp.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "awaiting", service: "bulk-loader" });
    await awaitingApp.close();
  });

  it("returns 200 with 0 workers connected (degraded liveness)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
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

  it("returns 200 at 50% (2 of 4) — liveness, readiness on /load/status", async () => {
    clients[0]!.becomeReady();
    clients[1]!.becomeReady();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("degraded");
  });
});

describe("GET /load/status", () => {
  it("reports pool_size, connected, and per-worker state shape", async () => {
    clients[0]!.becomeReady();
    const res = await app.inject({ method: "GET", url: "/load/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      instance_id: string;
      pool_size: number;
      connected: number;
      workers: Array<{ id: number; state: string; last_heartbeat: number | null; last_flush_at: number | null }>;
    };
    expect(body.instance_id).toBe(BULK_LOADER_INSTANCE_ID);
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

describe("GET /load/status — Wave 7.0.6.22 backpressure surface", () => {
  async function buildSlow(highWater: number, callDelayMs: number): Promise<{
    app: FastifyInstance; pool: WorkerPool; dispatcher: DispatcherHandle; clients: FakeWriteClient[];
  }> {
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
    writeClients[0]!.callDelayMs = callDelayMs;
    writeClients[1]!.callDelayMs = callDelayMs;
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
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater,
    });
    const localApp = await createServer({ pool: localPool, dispatcher });
    await localApp.ready();
    return { app: localApp, pool: localPool, dispatcher, clients: writeClients };
  }
  function makeRow(id: string): Row {
    return { id, risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1 } };
  }

  it("reports throttled=false, headroom_pct=1, recent_429_count=0 when idle", async () => {
    const { app: a, pool: p, dispatcher: d } = await buildSlow(64, 0);
    try {
      const res = await a.inject({ method: "GET", url: "/load/status" });
      const body = res.json() as {
        throttled: boolean; headroom_pct: number | null; recent_429_count: number;
      };
      expect(body.throttled).toBe(false);
      expect(body.headroom_pct).toBe(1);
      expect(body.recent_429_count).toBe(0);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("surfaces throttled=true and recent_429_count>0 after a 429 burst", async () => {
    // highWater=2 + 200ms write delay so a 3-row burst trips backpressure.
    const { app: a, pool: p, dispatcher: d } = await buildSlow(2, 200);
    try {
      const fill = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("a"), makeRow("b")]),
      });
      expect(fill.statusCode).toBe(202);
      const overflow = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("c")]),
      });
      expect(overflow.statusCode).toBe(429);
      const res = await a.inject({ method: "GET", url: "/load/status" });
      const body = res.json() as {
        throttled: boolean; headroom_pct: number | null; recent_429_count: number;
        dispatcher: { in_flight: number; high_water: number };
      };
      expect(body.recent_429_count).toBeGreaterThan(0);
      // headroom_pct < 0.2 OR recent_429_count > 0 ⇒ throttled.
      expect(body.throttled).toBe(true);
      expect(body.headroom_pct).not.toBeNull();
      expect(body.headroom_pct).toBeLessThan(1);
      await d.drain();
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("returns headroom_pct=null when no dispatcher is wired", async () => {
    // Pool-only server (no dispatcher) — headroom is undefined, throttled=false.
    const res = await app.inject({ method: "GET", url: "/load/status" });
    const body = res.json() as {
      throttled: boolean; headroom_pct: number | null; recent_429_count: number;
    };
    expect(body.headroom_pct).toBeNull();
    expect(body.throttled).toBe(false);
    expect(body.recent_429_count).toBe(0);
  });
});

describe("GET /load/checkpoints — Wave 7.0.5.A", () => {
  async function buildWithDispatcher(): Promise<{
    app: FastifyInstance; pool: WorkerPool; dispatcher: DispatcherHandle; clients: FakeWriteClient[];
  }> {
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
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
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
    });
    const localApp = await createServer({ pool: localPool, dispatcher });
    await localApp.ready();
    return { app: localApp, pool: localPool, dispatcher, clients: writeClients };
  }
  function makeRow(id: string): Row {
    return { id, risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1 } };
  }

  it("returns empty workers + null resume_ulid when no checkpoints + no live writes", async () => {
    const { app: a, pool: p, dispatcher: d } = await buildWithDispatcher();
    try {
      const res = await a.inject({ method: "GET", url: "/load/checkpoints" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { resume_ulid: string | null; workers: Array<{ id: number; source: string }> };
      expect(body.resume_ulid).toBeNull();
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("reports live worker watermark after a flush", async () => {
    const { app: a, pool: p, dispatcher: d } = await buildWithDispatcher();
    try {
      await d.enqueue(makeRow("01HZA00000000000000000"));
      await d.enqueue(makeRow("01HZB00000000000000000"));
      await d.drain();
      const res = await a.inject({ method: "GET", url: "/load/checkpoints" });
      const body = res.json() as {
        resume_ulid: string | null;
        workers: Array<{ id: number; rows_written: number; last_ulid: string | null; source: string }>;
      };
      expect(body.resume_ulid).toBe("01HZB00000000000000000");
      const live = body.workers.filter((w) => w.source === "live");
      expect(live.length).toBeGreaterThan(0);
      const total = live.reduce((s, w) => s + w.rows_written, 0);
      expect(total).toBe(2);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("falls back to bootstrap checkpoints when no live writes happened", async () => {
    const writeClients = [new FakeWriteClient()];
    const fakePool: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 1,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000,
      logger: { info: () => {} },
    });
    fakePool[0]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
    });
    const bootstrap = new Map([
      [0, { rows_written: 42, last_ulid: "01HZBOOT0000000000000A", last_updated: 1700000000000 }],
    ]);
    const localApp = await createServer({ pool: localPool, dispatcher, bootstrapCheckpoints: bootstrap });
    await localApp.ready();
    try {
      const res = await localApp.inject({ method: "GET", url: "/load/checkpoints" });
      const body = res.json() as {
        resume_ulid: string | null;
        workers: Array<{ id: number; rows_written: number; last_ulid: string | null; source: string }>;
      };
      expect(body.resume_ulid).toBe("01HZBOOT0000000000000A");
      const w = body.workers.find((x) => x.id === 0);
      expect(w?.source).toBe("bootstrap");
      expect(w?.rows_written).toBe(42);
    } finally {
      await localApp.close(); await dispatcher.stop(); await localPool.stop();
    }
  });

  it("live state supersedes bootstrap once a worker flushes a row", async () => {
    const writeClients = [new FakeWriteClient()];
    const fakePool: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 1,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000,
      logger: { info: () => {} },
    });
    fakePool[0]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
    });
    const bootstrap = new Map([
      [0, { rows_written: 1, last_ulid: "01HZBOOT00000000000000", last_updated: 1700000000000 }],
    ]);
    const localApp = await createServer({ pool: localPool, dispatcher, bootstrapCheckpoints: bootstrap });
    await localApp.ready();
    try {
      await dispatcher.enqueue(makeRow("01HZLIVE00000000000000"));
      await dispatcher.drain();
      const res = await localApp.inject({ method: "GET", url: "/load/checkpoints" });
      const body = res.json() as {
        resume_ulid: string | null;
        workers: Array<{ id: number; last_ulid: string | null; source: string }>;
      };
      expect(body.workers[0]?.source).toBe("live");
      expect(body.workers[0]?.last_ulid).toBe("01HZLIVE00000000000000");
      expect(body.resume_ulid).toBe("01HZLIVE00000000000000");
    } finally {
      await localApp.close(); await dispatcher.stop(); await localPool.stop();
    }
  });
});

describe("/load/rows — Wave 7.0.5.A body-drain error counter", () => {
  it("increments body_drain_errors and invokes logEvent on parse failure", async () => {
    const writeClients = [new FakeWriteClient()];
    const fakePool: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 1,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000,
      logger: { info: () => {} },
    });
    fakePool[0]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
    });
    const events: Array<{ level: string; obj: object; msg: string }> = [];
    const localApp = await createServer({
      pool: localPool, dispatcher,
      logEvent: (level, obj, msg) => events.push({ level, obj, msg }),
    });
    await localApp.ready();
    try {
      const before = await localApp.inject({ method: "GET", url: "/load/status" });
      expect((before.json() as { body_drain_errors: number }).body_drain_errors).toBe(0);

      const bad = await localApp.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "text/plain" },
        payload: "garbage",
      });
      expect(bad.statusCode).toBe(400);

      const after = await localApp.inject({ method: "GET", url: "/load/status" });
      expect((after.json() as { body_drain_errors: number }).body_drain_errors).toBe(1);
      expect(events.length).toBe(1);
      expect(events[0]?.level).toBe("warn");
      expect((events[0]?.obj as { evt?: string }).evt).toBe("bulk-load-body-parse-error");
    } finally {
      await localApp.close(); await dispatcher.stop(); await localPool.stop();
    }
  });
});

describe("Wave 7.0.6.17 — target_stale fail-loud + new /load/status fields", () => {
  async function buildWithState(staleInit?: { reason: string }): Promise<{
    app: FastifyInstance; pool: WorkerPool; dispatcher: DispatcherHandle; state: BulkLoaderState;
  }> {
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
    const fakePool: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 2,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000, logger: { info: () => { } },
    });
    fakePool[0]!.becomeReady();
    fakePool[1]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
    });
    const state = createBulkLoaderState({
      pool: localPool, dispatcher, checkpointer: null,
      bootstrapCheckpoints: new Map(),
      boundTarget: { host: "127.0.0.1", port: 12000, label: "localcluster" },
      boundVersion: 3, targetWatcher: "enabled",
    });
    if (staleInit) {
      state.targetStale = true;
      state.targetStaleReason = staleInit.reason;
    }
    const localApp = await createServer({ state });
    await localApp.ready();
    return { app: localApp, pool: localPool, dispatcher, state };
  }
  function makeRow(id: string): Row {
    return { id, risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1 } };
  }

  it("/load/status surfaces bound_target, target_stale, target_watcher, target_swap_count", async () => {
    const { app: a, pool: p, dispatcher: d } = await buildWithState();
    try {
      const res = await a.inject({ method: "GET", url: "/load/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        bound_target: { host: string; port: number; label: string };
        target_stale: boolean; target_stale_reason: string | null;
        api_active_target: unknown; target_swap_count: number;
        last_swap_error: string | null; target_watcher: string;
        accepting: boolean; oom_rejected_total: number;
        workers: Array<{ oom_rejected: number | null }>;
      };
      expect(body.bound_target).toEqual({ host: "127.0.0.1", port: 12000, label: "localcluster" });
      expect(body.target_stale).toBe(false);
      expect(body.target_stale_reason).toBeNull();
      expect(body.api_active_target).toBeNull();
      expect(body.target_swap_count).toBe(0);
      expect(body.last_swap_error).toBeNull();
      expect(body.target_watcher).toBe("enabled");
      expect(body.accepting).toBe(true);
      expect(body.oom_rejected_total).toBe(0);
      expect(body.workers.every((w) => w.oom_rejected === 0)).toBe(true);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("/load/rows returns 503 with the stale-target reason when target_stale=true", async () => {
    const reason = "stale target: bulk-loader bound to localcluster but api active-target is cloud";
    const { app: a, pool: p, dispatcher: d } = await buildWithState({ reason });
    try {
      const res = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("u1")]),
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { accepted: number; reason: string };
      expect(body.accepted).toBe(0);
      expect(body.reason).toBe(reason);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("/healthz returns 503 + status=degraded with target_stale=true when bound target diverged", async () => {
    const reason = "stale target: bulk-loader bound to localcluster but api active-target is cloud";
    const { app: a, pool: p, dispatcher: d } = await buildWithState({ reason });
    try {
      const res = await a.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; target_stale: boolean; reason: string };
      expect(body.status).toBe("degraded");
      expect(body.target_stale).toBe(true);
      expect(body.reason).toBe(reason);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("oom_rejected_total sums per-worker oom_rejected when the dispatcher is wired", async () => {
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
    const OOM_MSG = "OOM command not allowed when used memory > 'maxmemory'.";
    writeClients[0]!.nextReplies = [[new Error(OOM_MSG), null]];
    writeClients[1]!.nextReplies = [[new Error(OOM_MSG), null]];
    const fakePool: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 2,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000, logger: { info: () => { } },
    });
    fakePool[0]!.becomeReady();
    fakePool[1]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64, maxRetries: 1,
    });
    const state = createBulkLoaderState({
      pool: localPool, dispatcher, checkpointer: null,
      bootstrapCheckpoints: new Map(),
      boundTarget: { host: "127.0.0.1", port: 12000, label: "localcluster" },
      targetWatcher: "enabled",
    });
    const localApp = await createServer({ state });
    await localApp.ready();
    try {
      await dispatcher.enqueue(makeRow("u1"));
      await dispatcher.enqueue(makeRow("u2"));
      await dispatcher.drain();
      const res = await localApp.inject({ method: "GET", url: "/load/status" });
      const body = res.json() as {
        oom_rejected_total: number;
        workers: Array<{ id: number; oom_rejected: number | null; errors: number | null }>;
      };
      expect(body.oom_rejected_total).toBe(2);
      expect(body.workers[0]?.oom_rejected).toBe(1);
      expect(body.workers[1]?.oom_rejected).toBe(1);
      expect(body.workers[0]?.errors).toBe(1);
    } finally {
      await localApp.close(); await dispatcher.stop(); await localPool.stop();
    }
  });
});

// Wave 7.0.6.17a — regression coverage for the token-unset deploy. The
// 7.0.6.17 implementation gated the stale-poll behind the token-gated
// /internal/redis/active-target/full endpoint, so a bulk-loader without
// INTERNAL_API_TOKEN silently kept writing to a divergent target. The
// fix introduces an unauthenticated /admin/active-target-identity
// endpoint on the api and rewires the bulk-loader's stale poll to it.
// These tests exercise the new helper end-to-end and assert that the
// bulk-loader's stale state + /healthz + /load/rows all fail-loud as
// soon as the polled identity diverges from bound_target.
describe("Wave 7.0.6.17a — public identity endpoint flips target_stale (token unset)", () => {
  async function buildLocal(): Promise<{
    app: FastifyInstance; pool: WorkerPool; dispatcher: DispatcherHandle; state: BulkLoaderState;
  }> {
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
    const fakePool: FakeClient[] = [];
    const localPool = createWorkerPool({
      size: 2,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000, logger: { info: () => { } },
    });
    fakePool[0]!.becomeReady();
    fakePool[1]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
    });
    const state = createBulkLoaderState({
      pool: localPool, dispatcher, checkpointer: null,
      bootstrapCheckpoints: new Map(),
      boundTarget: { host: "127.0.0.1", port: 12000, label: "localcluster" },
      boundVersion: 1,
      // Token-unset deploy → watcher disabled. This is the failure mode
      // that 7.0.6.17 left unguarded.
      targetWatcher: "disabled",
    });
    const localApp = await createServer({ state });
    await localApp.ready();
    return { app: localApp, pool: localPool, dispatcher, state };
  }
  function makeRow(id: string): Row {
    return { id, risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1 } };
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it("fetchActiveTargetIdentity hits /admin/active-target-identity with no Authorization header", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      // The helper must NOT attach a bearer token — public endpoint by
      // design (creds-bearing /internal/redis/active-target/full stays
      // token-gated and untouched).
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      expect(String(input)).toBe("http://api.local/admin/active-target-identity");
      return new Response(JSON.stringify({
        host: "10.0.0.7", port: 12345, label: "redis-cloud-prod", version: 17,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const out = await fetchActiveTargetIdentity("http://api.local");
    expect(out).toEqual({ host: "10.0.0.7", port: 12345, label: "redis-cloud-prod", version: 17 });
  });

  it("returns null on non-2xx, malformed body, or fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    expect(await fetchActiveTargetIdentity("http://api.local")).toBeNull();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ host: "x" }), { status: 200 })));
    expect(await fetchActiveTargetIdentity("http://api.local")).toBeNull();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchActiveTargetIdentity("http://api.local")).toBeNull();
  });

  it("identity poll flips target_stale=true, /load/rows + /healthz return 503, /load/status reports target_watcher=disabled", async () => {
    const { app: a, pool: p, dispatcher: d, state } = await buildLocal();
    try {
      // No token in the env, divergent identity from the api → the poll
      // must observe the divergence and call updateApiActiveTarget. We
      // stub fetch (no auth header expected) and drive the poll manually
      // so the test is deterministic instead of waiting on setInterval.
      delete process.env.INTERNAL_API_TOKEN;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        host: "10.0.0.7", port: 12345, label: "redis-cloud-prod", version: 99,
      }), { status: 200 })));

      const id = await fetchActiveTargetIdentity("http://api.local");
      expect(id).not.toBeNull();
      updateApiActiveTarget(state, { host: id!.host, port: id!.port, label: id!.label }, id!.version);

      expect(state.targetStale).toBe(true);
      expect(state.targetStaleReason).toMatch(/stale target/);
      expect(state.targetStaleReason).toMatch(/localcluster/);
      expect(state.targetStaleReason).toMatch(/redis-cloud-prod/);

      const rows = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("u1")]),
      });
      expect(rows.statusCode).toBe(503);
      const rowsBody = rows.json() as { accepted: number; reason: string };
      expect(rowsBody.accepted).toBe(0);
      expect(rowsBody.reason).toMatch(/stale target/);

      const health = await a.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(503);
      const healthBody = health.json() as { status: string; target_stale: boolean };
      expect(healthBody.status).toBe("degraded");
      expect(healthBody.target_stale).toBe(true);

      const status = await a.inject({ method: "GET", url: "/load/status" });
      const statusBody = status.json() as {
        target_stale: boolean; target_watcher: string;
        bound_target: { label: string }; api_active_target: { label: string } | null;
      };
      expect(statusBody.target_stale).toBe(true);
      expect(statusBody.target_watcher).toBe("disabled");
      expect(statusBody.bound_target.label).toBe("localcluster");
      expect(statusBody.api_active_target?.label).toBe("redis-cloud-prod");
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });

  it("identity poll keeps target_stale=false and /load/rows accepts when identity matches bound_target", async () => {
    const { app: a, pool: p, dispatcher: d, state } = await buildLocal();
    try {
      delete process.env.INTERNAL_API_TOKEN;
      // Identity converges on the bound target — same host/port/label.
      // updateApiActiveTarget must NOT flip stale; /load/rows must accept.
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        host: "127.0.0.1", port: 12000, label: "localcluster", version: 2,
      }), { status: 200 })));

      const id = await fetchActiveTargetIdentity("http://api.local");
      expect(id).not.toBeNull();
      updateApiActiveTarget(state, { host: id!.host, port: id!.port, label: id!.label }, id!.version);

      expect(state.targetStale).toBe(false);
      expect(state.targetStaleReason).toBeNull();

      const rows = await a.inject({
        method: "POST", url: "/load/rows",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify([makeRow("u1")]),
      });
      expect(rows.statusCode).toBe(202);
      expect((rows.json() as { accepted: number }).accepted).toBe(1);

      const health = await a.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
    } finally {
      await a.close(); await d.stop(); await p.stop();
    }
  });
});
