import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { loadSchema, type Schema } from "@frtb/schema";
import {
  registerIngestRoutes,
  _testResetBulkRuns,
} from "../src/routes/ingest.ts";
import {
  computeRunPhase,
  computeRowsWritten,
  computeFlushRpsFromDelta,
  stabilizeRunRowsWritten,
  trackLoaderFlushedTotal,
  _testResetIngestSnapshotState,
} from "../src/routes/ingest-snapshot.ts";
import { _testResetSensKeyCountCache } from "../src/lib/sens-key-count-cache.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import type { FakeRedis } from "./helpers/fake-redis.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixtureSchema(): Schema {
  return loadSchema(resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"));
}

const bulkStatus = {
  instance_id: "bl-1",
  pool_size: 32,
  connected: 32,
  dispatcher: { in_flight: 10, high_water: 100 },
  throttled: false,
  recent_429_count: 0,
  workers: [{ flushed: 5000 }],
};

function mountApp(schema: Schema, redis: FakeRedis) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    (req as unknown as { poolCategory: string }).poolCategory = "light";
  });
  registerIngestRoutes(app, schema, {
    bulkLoaderBase: "http://127.0.0.1:1",
    fetchImpl: async () => new Response(JSON.stringify(bulkStatus), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    availableCores: () => 8,
    getRedis: async () => redis,
  });
  return app;
}

describe("ingest snapshot helpers", () => {
  afterEach(() => {
    _testResetIngestSnapshotState();
  });

  it("computeRowsWritten subtracts flushed_at_start", () => {
    expect(computeRowsWritten(9000, 4000)).toBe(5000);
    expect(computeRowsWritten(3000, 4000)).toBe(0);
    expect(computeRowsWritten(1000, null)).toBe(0);
  });

  it("computeRunPhase returns writing when producer finished before writer", () => {
    expect(computeRunPhase(
      { status: "running", rows_total: 10_000, rows_sent: 10_000, rows_written: 9000 },
      { throttled: false, in_flight: 5 },
    )).toBe("writing");
  });

  it("computeRunPhase returns draining when cancelled with in_flight", () => {
    expect(computeRunPhase(
      { status: "cancelled", rows_total: 10_000, rows_sent: 5000, rows_written: 4000 },
      { throttled: false, in_flight: 3 },
    )).toBe("draining");
  });

  it("computeFlushRpsFromDelta returns 0 when no new rows or window too short", () => {
    expect(computeFlushRpsFromDelta(10_000, 1)).toBe(10_000);
    expect(computeFlushRpsFromDelta(0, 1)).toBe(0);
    expect(computeFlushRpsFromDelta(10_000, 0.1)).toBe(0);
  });

  it("stabilizeRunRowsWritten stays monotonic when raw flush delta drops to zero", () => {
    _testResetIngestSnapshotState();
    const run = {
      status: "running",
      rows_sent: 4_400_000,
      rows_total: 50_000_000,
      phase: "producing" as const,
    };
    expect(stabilizeRunRowsWritten("01RUN", run, 3_537_782)).toBe(4_400_000);
    expect(stabilizeRunRowsWritten("01RUN", run, 0)).toBe(4_400_000);
    expect(stabilizeRunRowsWritten("01RUN", { ...run, rows_sent: 4_800_000 }, 0)).toBe(4_800_000);
  });

  it("trackLoaderFlushedTotal stays monotonic across flaky replica probes", () => {
    _testResetIngestSnapshotState();
    expect(trackLoaderFlushedTotal(101_092_735, true)).toBe(101_092_735);
    expect(trackLoaderFlushedTotal(32_593_540, true)).toBe(101_092_735);
    expect(trackLoaderFlushedTotal(105_483_848, true)).toBe(105_483_848);
    trackLoaderFlushedTotal(0, false);
    expect(trackLoaderFlushedTotal(50_000, true)).toBe(50_000);
  });
});

describe("GET /ingest/snapshot", () => {
  afterEach(() => {
    _testResetBulkRuns();
    _testResetIngestSnapshotState();
    _testResetSensKeyCountCache();
  });

  it("returns cluster, loader, and run rows_written from flush baseline", async () => {
    const redis = fakeRedis();
    const app = mountApp(loadFixtureSchema(), redis);

    const startRes = await app.inject({
      method: "POST",
      url: "/ingest/bulk/start",
      payload: { rows: 100, workers: 1 },
    });
    expect(startRes.statusCode).toBe(202);
    const run_id = startRes.json().run_id as string;
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.inject({ method: "GET", url: "/ingest/snapshot" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.cluster).toMatchObject({
      sens_count: expect.any(Number),
      memory_bytes: expect.any(Number),
    });
    expect(body.loader.flush_rps).toBeGreaterThanOrEqual(0);
    expect(body.loader.flushed_total).toBe(5000);
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    const run = body.runs.find((r: { run_id: string }) => r.run_id === run_id);
    expect(run).toBeDefined();
    expect(run.phase).toBeDefined();
    expect(run.rows_written).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});
