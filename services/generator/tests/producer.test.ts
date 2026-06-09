import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { createStreamProducer, MAX_PIPELINE_WINDOW, type SensitivityRow } from "../src/producer.ts";
import { createStreamRouter } from "@frtb/stream-router";

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

// Wave 5.84A — pipeline-window concurrency. These tests do NOT need a live
// redis: they wire createStreamProducer to a stub pipeline client that
// records per-exec XADD arg-tuples and tracks the high-water mark of
// concurrent in-flight pipelines. The bit-equivalence test is the canary
// guarding the entire 5.84 wave — `pipelineWindow=1` (the default) MUST
// produce the same XADD command sequence as the pre-5.84A producer.
type StubPipelineClient = {
  execCalls: string[][][];
  readonly maxInFlight: number;
  pipeline(): {
    xadd(...args: string[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]>>;
  };
};

function stubPipelineClient(): StubPipelineClient {
  const execCalls: string[][][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    execCalls,
    get maxInFlight() { return maxInFlight; },
    pipeline() {
      const buffered: string[][] = [];
      return {
        xadd(...args: string[]) {
          buffered.push(args);
          return this;
        },
        async exec(): Promise<Array<[Error | null, unknown]>> {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          // Two setImmediate ticks per exec so additional dispatches under
          // window>1 actually overlap in flight before this one resolves.
          await new Promise<void>((r) => setImmediate(r));
          await new Promise<void>((r) => setImmediate(r));
          inFlight--;
          execCalls.push(buffered);
          return buffered.map(() => [null, "0-0"] as [Error | null, unknown]);
        },
      };
    },
  };
  return client;
}

function makeRow(i: number): SensitivityRow {
  return {
    risk_class: "GIRR",
    bucket: "USD",
    risk_value: i,
    _hash_tag: "GIRR:USD",
    _id: `01HXTESTEQUIV${String(i).padStart(13, "0")}`,
  };
}

describe("Wave 5.84A — pipeline window", () => {
  it("window=1 (default) is bit-identical to explicit pipelineWindow=1", async () => {
    const a = stubPipelineClient();
    const b = stubPipelineClient();
    const pa = createStreamProducer(a as never, { stream: "s", batchSize: 50 });
    const pb = createStreamProducer(b as never, { stream: "s", batchSize: 50, pipelineWindow: 1 });
    for (let i = 0; i < 137; i++) {
      await pa.add(makeRow(i));
      await pb.add(makeRow(i));
    }
    await pa.flush();
    await pb.flush();
    expect(a.execCalls).toEqual(b.execCalls);
    expect(a.execCalls.length).toBe(3); // 50 + 50 + 37
    expect(a.execCalls[0]!.length).toBe(50);
    expect(a.execCalls[1]!.length).toBe(50);
    expect(a.execCalls[2]!.length).toBe(37);
    expect(a.maxInFlight).toBe(1);
    expect(b.maxInFlight).toBe(1);
  });

  it("window=4 keeps ≤4 in flight; totals + per-class counts unchanged vs window=1", async () => {
    // Drive each producer through its OWN sequential loop. Interleaving the
    // two would force a macrotask yield on every pa.add() that fills, which
    // drains pb's queue between pb's dispatches and hides the windowing.
    const a = stubPipelineClient();
    const pa = createStreamProducer(a as never, { stream: "s", batchSize: 50, pipelineWindow: 1 });
    for (let i = 0; i < 537; i++) await pa.add(makeRow(i));
    await pa.flush();

    const b = stubPipelineClient();
    const pb = createStreamProducer(b as never, { stream: "s", batchSize: 50, pipelineWindow: 4 });
    for (let i = 0; i < 537; i++) await pb.add(makeRow(i));
    await pb.flush();

    expect(pb.batchCount).toBe(pa.batchCount);
    expect(pb.rowsSent).toBe(pa.rowsSent);
    expect(pb.byClass).toEqual(pa.byClass);
    expect(b.execCalls.length).toBe(a.execCalls.length);
    expect(a.maxInFlight).toBe(1);
    expect(b.maxInFlight).toBeGreaterThan(1);
    expect(b.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("clamps pipelineWindow to MAX_PIPELINE_WINDOW (8)", async () => {
    const c = stubPipelineClient();
    const p = createStreamProducer(c as never, { stream: "s", batchSize: 10, pipelineWindow: 99 });
    for (let i = 0; i < 200; i++) await p.add(makeRow(i));
    await p.flush();
    expect(c.maxInFlight).toBeLessThanOrEqual(MAX_PIPELINE_WINDOW);
  });

  it("flush() drains all in-flight pipelines before returning", async () => {
    const c = stubPipelineClient();
    const p = createStreamProducer(c as never, { stream: "s", batchSize: 25, pipelineWindow: 4 });
    for (let i = 0; i < 200; i++) await p.add(makeRow(i));
    await p.flush();
    expect(c.execCalls.length).toBe(8);
    const totalXadds = c.execCalls.reduce((acc, batch) => acc + batch.length, 0);
    expect(totalXadds).toBe(200);
    expect(p.rowsSent).toBe(200);
  });
});

// Wave 5.92A — multi-stream routing. The producer accepts an optional
// `StreamRouter`; when N>1, rows fan out across N hash-tag-partitioned
// streams keyed by FNV-1a(_hash_tag) % N. Single-buffer / single-key
// bit-equivalence is already covered by the Wave 5.84A canary above; these
// tests assert the new behaviour without disturbing it.
function makeRowWithTag(i: number, hashTag: string): SensitivityRow {
  return {
    risk_class: "GIRR",
    bucket: "B0",
    risk_value: i,
    _hash_tag: hashTag,
    _id: `01HXTESTSHARD${String(i).padStart(13, "0")}`,
  };
}

describe("Wave 5.92A — stream-router fan-out", () => {
  it("N=1 router is bit-identical to no router (same XADD sequence)", async () => {
    const a = stubPipelineClient();
    const b = stubPipelineClient();
    const router = createStreamRouter("sensitivities:in", 1);
    const pa = createStreamProducer(a as never, { stream: "sensitivities:in", batchSize: 50 });
    const pb = createStreamProducer(b as never, { stream: "sensitivities:in", batchSize: 50, router });
    for (let i = 0; i < 137; i++) {
      await pa.add(makeRowWithTag(i, `GIRR:B${i % 20}`));
      await pb.add(makeRowWithTag(i, `GIRR:B${i % 20}`));
    }
    await pa.flush();
    await pb.flush();
    expect(b.execCalls).toEqual(a.execCalls);
  });

  it("N=4 router fans XADDs across all 4 stream keys (every key receives rows)", async () => {
    const c = stubPipelineClient();
    const router = createStreamRouter("sensitivities:in", 4);
    const p = createStreamProducer(c as never, { stream: "sensitivities:in", batchSize: 50, router });
    // Wide tag spread so FNV-1a hits every modulo bucket.
    const classes = ["GIRR", "FX", "EQUITY", "CSR", "CMD", "EQDELTA", "FXVEGA", "GIRRSWP"];
    let i = 0;
    for (const rc of classes) {
      for (let b = 0; b < 80; b++) await p.add(makeRowWithTag(i++, `${rc}:B${b}`));
    }
    await p.flush();
    const streamsHit = new Set<string>();
    for (const batch of c.execCalls) {
      for (const args of batch) streamsHit.add(args[0]!);
    }
    expect(streamsHit.size).toBe(4);
    for (const key of router.shardKeys()!) expect(streamsHit.has(key)).toBe(true);
  });

  it("router preserves per-stream XADD order (rows with same hash-tag stay sequential within their stream)", async () => {
    const c = stubPipelineClient();
    const router = createStreamRouter("sensitivities:in", 4);
    const p = createStreamProducer(c as never, { stream: "sensitivities:in", batchSize: 10, router });
    // Tag each row with its index inside _id; we'll recover per-stream
    // ordering and assert it's monotonically non-decreasing per stream key.
    for (let i = 0; i < 200; i++) {
      await p.add(makeRowWithTag(i, `GIRR:B${i % 16}`));
    }
    await p.flush();
    const perStreamIds = new Map<string, number[]>();
    for (const batch of c.execCalls) {
      for (const args of batch) {
        const streamKey = args[0]!;
        const idIdx = args.indexOf("_id");
        const id = args[idIdx + 1]!;
        const seq = Number(id.slice(-13));
        if (!perStreamIds.has(streamKey)) perStreamIds.set(streamKey, []);
        perStreamIds.get(streamKey)!.push(seq);
      }
    }
    for (const [, seqs] of perStreamIds) {
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      }
    }
  });

  it("pipelineWindow is the GLOBAL cap across all per-stream pipelines (≤window in flight, summed)", async () => {
    const c = stubPipelineClient();
    const router = createStreamRouter("sensitivities:in", 4);
    const p = createStreamProducer(c as never, { stream: "sensitivities:in", batchSize: 25, pipelineWindow: 2, router });
    for (let i = 0; i < 400; i++) {
      await p.add(makeRowWithTag(i, `GIRR:B${i % 16}`));
    }
    await p.flush();
    expect(c.maxInFlight).toBeLessThanOrEqual(2);
    expect(p.rowsSent).toBe(400);
  });
});
