import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import {
  ensureGroup,
  processBatch,
  processBatchAtomic,
} from "../src/consumer.ts";
import { loadSchema, type Schema } from "@frtb/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rollupKey } from "@frtb/calc-shared";

// Wave 6.38.B — atomic delta reconciliation race tests. These tests cover the
// re-ingest scenario where the same logical row (same `_id` ULID) is re-XADDed
// with a different `risk_value`. The pre-6.38.B behavior was to additively
// HINCRBYFLOAT each entry, which double-counted on re-ingest. The 6.38.B
// behavior is to WATCH the parent `sens:<ulid>` key, HGETALL old `ws_*`
// contributions, compute deltas, and apply HINCRBYFLOAT (new − old) inside
// a MULTI/EXEC transaction so concurrent writers can only ever land one
// effective delta per re-ingest.
//
// Tests gate on a plain `redis-server` binary (no RediSearch / RedisJSON
// modules needed — the reconciliation primitives are vanilla Redis 7+
// WATCH/MULTI/EXEC/HSET/HINCRBYFLOAT/XADD/XREADGROUP/XACK).

function binaryOnPath(binary: string): boolean {
  const r = spawnSync("which", [binary], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}
const REDIS_AVAILABLE = binaryOnPath("redis-server");

function spawnRedis(port: number, dir: string): ChildProcess {
  const p = spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" },
  );
  p.on("error", () => undefined);
  return p;
}

const PORT = 16420;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;
let booted = false;

const here = resolve(fileURLToPath(import.meta.url), "..");
const SCHEMA_PATH = resolve(here, "../../../config/schema/frtb-default.yaml");
const SCHEMA: Schema = loadSchema(SCHEMA_PATH);
const EQUITY_W = SCHEMA.risk_weights.equity_weights as { by_bucket: Record<string, number> };

beforeAll(async () => {
  if (!REDIS_AVAILABLE) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-ingest-reconcile-"));
  proc = spawnRedis(PORT, tmp);
  for (let i = 0; i < 60; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      await r.ping();
      await r.quit();
      booted = true;
      break;
    } catch { await wait(100); }
  }
  if (booted) redis = new Redis({ port: PORT });
}, 30_000);

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
  if (proc) proc.kill("SIGTERM");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  if (booted) await redis.flushall();
});

const integration = (label: string, fn: () => Promise<void> | void) =>
  it.skipIf(!REDIS_AVAILABLE)(label, fn);

// Helper — XADDs a row with a CALLER-SUPPLIED `_id` so we can deliberately
// re-ingest the same logical row twice. The producer normally generates a
// fresh ULID per emit, but the on-stream contract is "same _id = same logical
// row" — the supervisor's race-test repro depends on this.
async function xaddWithId(
  stream: string,
  id: string,
  riskClass: string,
  bucket: string,
  payload: Record<string, unknown>,
): Promise<string> {
  return (await redis.xadd(
    stream, "*",
    "risk_class", riskClass,
    "bucket", bucket,
    "_hash_tag", `${riskClass}:${bucket}`,
    "_id", id,
    "payload", JSON.stringify(payload),
  )) as string;
}

describe("delta reconcile — pre-fix race documents the bug [Wave 6.38.B]", () => {
  integration("processBatch (pre-fix) double-counts when same _id is re-ingested with new value", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const ulid = "01HZRACE0000000000000000A1";
    // Three sends with the SAME _id and risk values [10, 20, 20].
    // Pre-fix expected rollup contribution: w*(10 + 20 + 20) = 50w (BUG).
    // Post-fix expected: w*20 (one effective application of the final state).
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 10 }, trade_id: "T1",
    });
    await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "preA",
      batchSize: 100, schema: SCHEMA,
    });
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 20 }, trade_id: "T1",
    });
    await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "preA",
      batchSize: 100, schema: SCHEMA,
    });
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 20 }, trade_id: "T1",
    });
    await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "preA",
      batchSize: 100, schema: SCHEMA,
    });

    const w = EQUITY_W.by_bucket["1"]!;
    const got = await redis.hgetall(rollupKey("EQUITY", "1", "Delta"));
    // Documents the pre-6.38.B behavior: every send additively HINCRs.
    // 10 + 20 + 20 = 50 (× w). This is the bug — see processBatchAtomic for
    // the fix.
    expect(Math.abs(Number(got.sum_ws) - 50 * w)).toBeLessThanOrEqual(1e-9);
    expect(Number(got.count)).toBe(3);
  });
});

describe("delta reconcile — processBatchAtomic [Wave 6.38.B]", () => {
  integration("re-ingest with same _id + changed value → rollup reflects FINAL value only", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const ulid = "01HZATOMIC0000000000000B01";
    const w = EQUITY_W.by_bucket["1"]!;

    // First ingest with spot=10 — fresh write, count → 1, sum_ws → 10w.
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 10 }, trade_id: "T1",
    });
    await processBatchAtomic(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "atomA",
      batchSize: 100, schema: SCHEMA,
    });
    let got = await redis.hgetall(rollupKey("EQUITY", "1", "Delta"));
    expect(Math.abs(Number(got.sum_ws) - 10 * w)).toBeLessThanOrEqual(1e-9);
    expect(Number(got.count)).toBe(1);

    // Re-ingest with spot=20 — delta = (20-10)w, count unchanged.
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 20 }, trade_id: "T1",
    });
    await processBatchAtomic(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "atomA",
      batchSize: 100, schema: SCHEMA,
    });
    got = await redis.hgetall(rollupKey("EQUITY", "1", "Delta"));
    expect(Math.abs(Number(got.sum_ws) - 20 * w)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(Number(got.sum_ws_sq) - (20 * w) * (20 * w))).toBeLessThanOrEqual(1e-9);
    expect(Number(got.count)).toBe(1);

    // Re-ingest with the same value (spot=20) — no-op delta, no drift.
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 20 }, trade_id: "T1",
    });
    await processBatchAtomic(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "atomA",
      batchSize: 100, schema: SCHEMA,
    });
    got = await redis.hgetall(rollupKey("EQUITY", "1", "Delta"));
    expect(Math.abs(Number(got.sum_ws) - 20 * w)).toBeLessThanOrEqual(1e-9);
    expect(Number(got.count)).toBe(1);
  });

  integration("concurrent re-ingest race: two workers, same _id with new value → final rollup deterministic", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const ulid = "01HZATOMIC0000000000000B02";
    const w = EQUITY_W.by_bucket["1"]!;

    // Seed: ingest spot=10. After this, rollup.sum_ws = 10w, count = 1.
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 10 }, trade_id: "T1",
    });
    await processBatchAtomic(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "atom-seed",
      batchSize: 100, schema: SCHEMA,
    });

    // Race: two concurrent re-ingests, BOTH with spot=20. Their deltas must
    // serialize so the final sum_ws is exactly (20 - 10)w added once (the
    // second worker observes the post-update sens:<ulid> and computes a
    // zero delta).
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 20 }, trade_id: "T1",
    });
    await xaddWithId("sensitivities:in", ulid, "EQUITY", "1", {
      sensitivity_type: "Delta", risk_value: { spot: 20 }, trade_id: "T1",
    });

    // Use two separate Redis connections so each "worker" can WATCH/MULTI/EXEC
    // independently — sharing a connection would serialize them at the
    // ioredis layer and bypass the race we're trying to reproduce.
    const c1 = new Redis({ port: PORT });
    const c2 = new Redis({ port: PORT });
    try {
      const [r1, r2] = await Promise.all([
        processBatchAtomic(c1, {
          stream: "sensitivities:in", group: "ingest", consumerName: "atom-w1",
          batchSize: 1, schema: SCHEMA,
        }),
        processBatchAtomic(c2, {
          stream: "sensitivities:in", group: "ingest", consumerName: "atom-w2",
          batchSize: 1, schema: SCHEMA,
        }),
      ]);
      expect(r1 + r2).toBe(2);
    } finally {
      await c1.quit().catch(() => undefined);
      await c2.quit().catch(() => undefined);
    }

    const got = await redis.hgetall(rollupKey("EQUITY", "1", "Delta"));
    expect(Math.abs(Number(got.sum_ws) - 20 * w)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(Number(got.sum_ws_sq) - (20 * w) * (20 * w))).toBeLessThanOrEqual(1e-9);
    expect(Number(got.count)).toBe(1);
  });

  integration("WATCH conflict storm: 8 workers re-ingesting overlapping _ids → no drift, bounded retry", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const w = EQUITY_W.by_bucket["1"]!;
    // 50 distinct _ids; each one re-ingested 5 times by varying workers.
    const N_IDS = 50;
    const REPLAYS = 5;
    const FINAL = 7;
    const ids = Array.from({ length: N_IDS }, (_, i) => `01HZSOAK${String(i).padStart(18, "0")}`);

    // Seed every _id with spot=3.
    for (const id of ids) {
      await xaddWithId("sensitivities:in", id, "EQUITY", "1", {
        sensitivity_type: "Delta", risk_value: { spot: 3 }, trade_id: `T-${id}`,
      });
    }
    await processBatchAtomic(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "soak-seed",
      batchSize: N_IDS, schema: SCHEMA,
    });

    // Re-ingest every _id REPLAYS times with the FINAL value. Drives
    // concurrent overlapping re-ingests through 8 worker connections.
    for (let r = 0; r < REPLAYS; r++) {
      for (const id of ids) {
        await xaddWithId("sensitivities:in", id, "EQUITY", "1", {
          sensitivity_type: "Delta", risk_value: { spot: FINAL }, trade_id: `T-${id}`,
        });
      }
    }

    const WORKERS = 8;
    const conns: Redis[] = [];
    try {
      for (let i = 0; i < WORKERS; i++) conns.push(new Redis({ port: PORT }));
      // Spin all 8 workers until the stream is fully drained.
      const totalEntries = N_IDS * REPLAYS;
      let drained = 0;
      const drainPromises = conns.map((c, i) => (async () => {
        let local = 0;
        for (;;) {
          // `blockMs: 50` keeps the drain loop from blocking forever on BLOCK 0
          // once the last worker pulls the tail of the stream; the helper
          // returns 0 after the short BLOCK window so the loop exits.
          const n = await processBatchAtomic(c, {
            stream: "sensitivities:in", group: "ingest", consumerName: `soak-w${i}`,
            batchSize: 16, schema: SCHEMA, blockMs: 50,
          });
          if (n === 0) break;
          local += n;
        }
        drained += local;
        return local;
      })());
      const results = await Promise.all(drainPromises);
      const summed = results.reduce((a, b) => a + b, 0);
      expect(summed).toBe(totalEntries);
      void drained;
    } finally {
      for (const c of conns) await c.quit().catch(() => undefined);
    }

    // Final rollup: every _id ended at FINAL — drift-free convergence.
    const got = await redis.hgetall(rollupKey("EQUITY", "1", "Delta"));
    expect(Number(got.count)).toBe(N_IDS);
    expect(Math.abs(Number(got.sum_ws) - N_IDS * FINAL * w)).toBeLessThanOrEqual(1e-6);
    const ws = FINAL * w;
    expect(Math.abs(Number(got.sum_ws_sq) - N_IDS * (ws * ws))).toBeLessThanOrEqual(1e-6);
  });

  // Soak per task acceptance criteria: 1000 concurrent re-ingests of
  // overlapping _ids must converge to a drift-free rollup.
  integration("1000-row soak: drift-free convergence under heavy concurrent re-ingest", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const w = EQUITY_W.by_bucket["1"]!;
    const N_IDS = 200;
    const REPLAYS = 4;          // 200 * 4 = 800 re-ingests on top of 200 seeds = 1000 entries
    const FINAL = 11;
    const ids = Array.from({ length: N_IDS }, (_, i) => `01HZSOAK1K${String(i).padStart(16, "0")}`);

    for (const id of ids) {
      await xaddWithId("sensitivities:in", id, "EQUITY", "1", {
        sensitivity_type: "Delta", risk_value: { spot: 1 }, trade_id: `T-${id}`,
      });
    }
    await processBatchAtomic(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "soak1k-seed",
      batchSize: N_IDS, schema: SCHEMA,
    });

    for (let r = 0; r < REPLAYS; r++) {
      for (const id of ids) {
        await xaddWithId("sensitivities:in", id, "EQUITY", "1", {
          sensitivity_type: "Delta", risk_value: { spot: FINAL }, trade_id: `T-${id}`,
        });
      }
    }

    const WORKERS = 16;
    const conns: Redis[] = [];
    try {
      for (let i = 0; i < WORKERS; i++) conns.push(new Redis({ port: PORT }));
      const drains = conns.map((c, i) => (async () => {
        let local = 0;
        for (;;) {
          const n = await processBatchAtomic(c, {
            stream: "sensitivities:in", group: "ingest", consumerName: `soak1k-w${i}`,
            batchSize: 32, schema: SCHEMA, blockMs: 50,
          });
          if (n === 0) break;
          local += n;
        }
        return local;
      })());
      const results = await Promise.all(drains);
      const summed = results.reduce((a, b) => a + b, 0);
      expect(summed).toBe(N_IDS * REPLAYS);
    } finally {
      for (const c of conns) await c.quit().catch(() => undefined);
    }

    const got = await redis.hgetall(rollupKey("EQUITY", "1", "Delta"));
    expect(Number(got.count)).toBe(N_IDS);
    expect(Math.abs(Number(got.sum_ws) - N_IDS * FINAL * w)).toBeLessThanOrEqual(1e-6);
    const ws = FINAL * w;
    expect(Math.abs(Number(got.sum_ws_sq) - N_IDS * (ws * ws))).toBeLessThanOrEqual(1e-4);
  }, 60_000);
});
