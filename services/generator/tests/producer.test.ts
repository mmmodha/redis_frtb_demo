import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { createStreamProducer, type SensitivityRow } from "../src/producer.ts";

// Local ephemeral redis-server keeps the producer test self-contained and fast.
// Skipped automatically when redis-server is not on PATH.
function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16399;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

// `it.skipIf` evaluates at test-registration time — detect redis-server on
// PATH synchronously at module load so the skip decision is made up-front.
function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-gen-redis-"));
  proc = spawnRedis(PORT, tmp);
  for (let i = 0; i < 30; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      await r.ping();
      await r.quit();
      redis = new Redis({ port: PORT });
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error("redis-server is on PATH but failed to start on port " + PORT);
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
  if (proc) proc.kill("SIGTERM");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  if (redisAvailable) await redis.flushall();
});

describe("createStreamProducer (XADD batching + pipelining)", () => {
  it.skipIf(!redisAvailable)("appends rows to the configured stream via XADD", async function () {
    const producer = createStreamProducer(redis, { stream: "sensitivities:in", batchSize: 64 });
    const row: SensitivityRow = {
      risk_class: "GIRR",
      bucket: "USD",
      risk_value: [1, 2, 3],
      _hash_tag: "GIRR:USD",
      _id: "01HXTESTONE0000000000000RR",
    };
    await producer.add(row);
    await producer.flush();
    const len = await redis.xlen("sensitivities:in");
    expect(len).toBe(1);
    const last = await redis.xrange("sensitivities:in", "-", "+", "COUNT", 1);
    expect(last).toHaveLength(1);
    const fields = last[0]![1];
    const map = Object.fromEntries(
      Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]])
    );
    expect(map.risk_class).toBe("GIRR");
    expect(map.bucket).toBe("USD");
    expect(map.payload).toBeDefined();
    const payload = JSON.parse(map.payload as string);
    expect(payload.risk_value).toEqual([1, 2, 3]);
  });

  it.skipIf(!redisAvailable)("batches XADDs via pipelining when the buffer fills", async () => {
    const producer = createStreamProducer(redis, { stream: "sensitivities:in", batchSize: 50 });
    for (let i = 0; i < 137; i++) {
      await producer.add({
        risk_class: "FX",
        bucket: "USDEUR",
        risk_value: i,
        _hash_tag: "FX:USDEUR",
        _id: `01HXTESTBATCH${String(i).padStart(13, "0")}`,
      });
    }
    await producer.flush();
    expect(await redis.xlen("sensitivities:in")).toBe(137);
    // batchCount counts pipeline flushes — 137 with batchSize 50 = 2 full + 1 partial = 3
    expect(producer.batchCount).toBe(3);
  });

  it.skipIf(!redisAvailable)("reports running totals so the CLI can print rows/sec", async () => {
    const producer = createStreamProducer(redis, { stream: "sensitivities:in", batchSize: 10 });
    for (let i = 0; i < 25; i++) {
      await producer.add({
        risk_class: "EQUITY",
        bucket: "1",
        risk_value: i,
        _hash_tag: "EQUITY:1",
        _id: `01HXTESTSTAT${String(i).padStart(14, "0")}`,
      });
    }
    await producer.flush();
    expect(producer.rowsSent).toBe(25);
    expect(producer.byClass.EQUITY).toBe(25);
  });
});
