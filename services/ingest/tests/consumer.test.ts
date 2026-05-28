import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { monotonicFactory } from "ulid";
import {
  buildKey,
  buildDoc,
  ensureGroup,
  processBatch,
  createConsumer,
} from "../src/consumer.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16410;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;
let redisAvailable = false;
let jsonAvailable = false;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "frtb-ingest-redis-"));
  proc = spawnRedis(PORT, tmp);
  for (let i = 0; i < 30; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      await r.ping();
      try {
        await r.call("JSON.SET", "__probe__", "$", '{"ok":1}');
        await r.del("__probe__");
        jsonAvailable = true;
      } catch { jsonAvailable = false; }
      await r.quit();
      redisAvailable = true;
      break;
    } catch {
      await wait(100);
    }
  }
  if (redisAvailable) redis = new Redis({ port: PORT });
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
  if (proc) proc.kill("SIGTERM");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  if (redisAvailable) await redis.flushall();
});

const ulid = monotonicFactory();

function makeRow(riskClass: string, bucket: string, rest: Record<string, unknown>) {
  const id = ulid();
  return {
    risk_class: riskClass,
    bucket,
    _hash_tag: `${riskClass}:${bucket}`,
    _id: id,
    payload: JSON.stringify(rest),
  };
}

async function xaddRow(stream: string, row: ReturnType<typeof makeRow>): Promise<string> {
  const args: string[] = [];
  for (const [k, v] of Object.entries(row)) { args.push(k, String(v)); }
  return (await redis.xadd(stream, "*", ...args)) as string;
}

describe("consumer pure helpers", () => {
  it("buildKey wraps hash tag in literal braces matching sens:{rc:bucket}:{ulid}", () => {
    const k = buildKey("GIRR:USD-IRS", "01HZABCDEF1234567890123456");
    expect(k).toBe("sens:{GIRR:USD-IRS}:01HZABCDEF1234567890123456");
    expect(k).toMatch(/^sens:\{[A-Z_]+:[^}]+\}:[A-Z0-9]+$/);
  });

  it("buildDoc merges top-level risk_class/bucket with payload JSON; strips meta fields", () => {
    const doc = buildDoc({
      risk_class: "GIRR",
      bucket: "USD",
      _hash_tag: "GIRR:USD",
      _id: "01HZ...",
      payload: JSON.stringify({
        sensitivity_type: "Delta",
        tenor: ["3M","6M"],
        risk_value: [0.1,0.2],
        weight_ref: "girr_delta_weights",
        correlation_ref: "girr_corr",
        trade_id: "T1",
      }),
    });
    expect(doc).toEqual({
      risk_class: "GIRR",
      bucket: "USD",
      sensitivity_type: "Delta",
      tenor: ["3M","6M"],
      risk_value: [0.1,0.2],
      weight_ref: "girr_delta_weights",
      correlation_ref: "girr_corr",
      trade_id: "T1",
    });
    // _hash_tag and _id must not leak into the stored JSON doc
    expect(doc).not.toHaveProperty("_hash_tag");
    expect(doc).not.toHaveProperty("_id");
    expect(doc).not.toHaveProperty("payload");
  });
});


// Integration tests run only when JSON.SET is available on the local Redis.
// Per Wave 1 follow-up #1, use it.skipIf() not the legacy if-guard pattern so
// coverage stays visible. In CI / on demo workstations redis-stack-server is
// expected to be on PATH and JSON ships with the locked Redis Enterprise 8.x runtime.
const integration = (label: string, fn: () => Promise<void> | void) =>
  it.skipIf(!redisAvailable || !jsonAvailable)(label, fn);

describe("XREADGROUP consumer → JSON.SET", () => {
  integration("ensureGroup creates the consumer group with MKSTREAM (idempotent on BUSYGROUP)", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    await ensureGroup(redis, "sensitivities:in", "ingest"); // second call is a no-op
    const groups = await redis.xinfo("GROUPS", "sensitivities:in") as unknown[];
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBe(1);
  });

  integration("writes one JSON doc per stream entry at sens:{rc:bucket}:{ulid} and XACKs it", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const rows = [
      makeRow("GIRR", "USD", { sensitivity_type: "Delta", tenor: ["3M","1Y","10Y"], risk_value: [0.1,0.2,0.3], weight_ref: "girr_delta_weights", correlation_ref: "girr_corr", trade_id: "T1" }),
      makeRow("EQUITY", "1", { sensitivity_type: "Delta", risk_value: 0.5, weight_ref: "equity_delta_weights", correlation_ref: "equity_corr", trade_id: "T2" }),
      makeRow("FX", "USDEUR", { sensitivity_type: "Vega", risk_value: 0.75, weight_ref: "fx_weights", correlation_ref: "fx_corr", trade_id: "T3" }),
    ];
    for (const r of rows) await xaddRow("sensitivities:in", r);

    const processed = await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1", batchSize: 100,
    }, ">");
    expect(processed).toBe(3);

    const keys = await redis.keys("sens:*");
    expect(keys).toHaveLength(3);
    const literalKeyShape = /^sens:\{[A-Z_]+:[^}]+\}:[A-Z0-9]+$/;
    for (const k of keys) expect(k, `key ${k} must match locked pattern`).toMatch(literalKeyShape);

    // XPENDING reports zero pending entries for the group after successful ack
    const pending = await redis.xpending("sensitivities:in", "ingest") as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });

  integration("stored JSON doc shape matches the locked Wave 2 contract", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const row = makeRow("GIRR", "USD-IRS", {
      sensitivity_type: "Delta",
      tenor: [0.25, 0.5, 1, 2, 3, 5, 10, 15, 20, 30],
      risk_value: [0.12, 0.34, 0.5, 0.6, 0.7, 0.65, 0.5, 0.4, 0.3, 0.2],
      weight_ref: "girr_delta_weights",
      correlation_ref: "girr_corr",
      trade_id: "T-7",
      book: "RATES-LDN",
    });
    await xaddRow("sensitivities:in", row);
    await processBatch(redis, { stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1" }, ">");

    const key = `sens:{GIRR:USD-IRS}:${row._id}`;
    const stored = JSON.parse(await redis.call("JSON.GET", key) as string);
    expect(stored).toMatchObject({
      risk_class: "GIRR",
      bucket: "USD-IRS",
      sensitivity_type: "Delta",
      weight_ref: "girr_delta_weights",
      correlation_ref: "girr_corr",
      trade_id: "T-7",
      book: "RATES-LDN",
    });
    expect(Array.isArray(stored.tenor)).toBe(true);
    expect(stored.tenor).toHaveLength(10);
    expect(Array.isArray(stored.risk_value)).toBe(true);
    expect(stored.risk_value).toHaveLength(10);
    // meta fields used only for routing must not leak into the stored doc
    expect(stored).not.toHaveProperty("_hash_tag");
    expect(stored).not.toHaveProperty("_id");
    expect(stored).not.toHaveProperty("payload");
  });

  integration("is idempotent — re-running on the same logical rows produces no duplicate keys", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeRow("GIRR", "USD", { sensitivity_type: "Delta", risk_value: [i, i+1], trade_id: `T-${i}` })
    );
    for (const r of rows) await xaddRow("sensitivities:in", r);

    await processBatch(redis, { stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1" }, ">");
    expect((await redis.keys("sens:*")).length).toBe(25);

    // Re-deliver the SAME logical rows (same _id ULIDs) under fresh XADD ids — a
    // second generator run replaying its buffer must not double-write docs.
    for (const r of rows) await xaddRow("sensitivities:in", r);
    await processBatch(redis, { stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1" }, ">");
    expect((await redis.keys("sens:*")).length).toBe(25);
  });

  integration("createConsumer runs an XREADGROUP loop and drains on stop()", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const rows = Array.from({ length: 50 }, () =>
      makeRow("EQUITY", "2", { sensitivity_type: "Delta", risk_value: 1.23 })
    );
    for (const r of rows) await xaddRow("sensitivities:in", r);

    const runner = createConsumer(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-runner", batchSize: 64, blockMs: 50,
    });
    runner.start();
    // Poll until all 50 docs are visible (cap at 5s wall-clock)
    for (let i = 0; i < 50 && (await redis.keys("sens:*")).length < 50; i++) await wait(100);
    await runner.stop();

    expect((await redis.keys("sens:*")).length).toBe(50);
    expect(runner.stats.acked).toBeGreaterThanOrEqual(50);
  });
});
