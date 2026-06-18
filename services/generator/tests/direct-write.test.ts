// Wave 6.39.A — direct-write end-to-end smoke against a live redis-server.
// Parameterised across all 4 STORAGE_FORMAT variants from 6.38.A. Plain
// redis-server lacks the RedisJSON module so the json / json-shadow-hash
// variants are skipped when JSON.SET errors out at boot (the underlying
// writeDocForStorage call is still covered by the stub-pipeline test).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import {
  enrichDoc, writeDocForStorage, buildKey,
  type StorageFormat,
} from "../../ingest/src/consumer.ts";
import { createRowGenerator } from "../src/row-generator.ts";
import { createDirectWriter } from "../src/direct-writer.ts";

function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");
const PORT = 16401;

let proc: ChildProcess | undefined;
let tmp: string;
let client: Redis;
let schema: Schema;
let jsonAvailable = false;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-direct-"));
  proc = spawn("redis-server",
    ["--port", String(PORT), "--dir", tmp, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" });
  for (let i = 0; i < 30; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect(); await r.ping(); await r.quit();
      client = new Redis({ port: PORT });
      try { await client.call("JSON.SET", "json:probe", "$", '"ok"'); jsonAvailable = true; await client.del("json:probe"); }
      catch { jsonAvailable = false; }
      schema = loadSchema(resolve(fileURLToPath(import.meta.url), "..", "fixtures/multi-class.yaml"));
      return;
    } catch { await wait(100); }
  }
  throw new Error("redis-server failed to start on port " + PORT);
});

afterAll(async () => {
  if (client) await client.quit().catch(() => undefined);
  if (proc) proc.kill("SIGTERM");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const FORMATS: readonly StorageFormat[] = ["hash-sidetable", "hash-encoded", "json", "json-shadow-hash"];
const hooks = { enrichDoc, writeDocForStorage, buildKey };

describe.each(FORMATS)("direct-write [%s] — Wave 6.39.A", (format) => {
  const needsJson = format === "json" || format === "json-shadow-hash";

  it.skipIf(!redisAvailable)("writes rows that are readable from redis", async function () {
    if (needsJson && !jsonAvailable) return;
    await client.flushall();
    const gen = createRowGenerator(schema, {
      seed: 11, distribution: "uniform", sensitivityTypes: ["Delta"],
    });
    const writer = createDirectWriter(client as never, {
      schema, storageFormat: format, batchSize: 50, hooks,
    });
    const N = 50;
    for (let i = 0; i < N; i++) await writer.add(gen.generate("FX"));
    await writer.flush();
    expect(writer.rowsSent).toBe(N);
    // Count parent sens keys (every format writes them, just under different
    // serialisations).
    const sensKeys = await scanCount(client, "sens:*");
    expect(sensKeys).toBeGreaterThanOrEqual(N);
    // Rollup hash exists per (rc, bkt, sens) tuple — at minimum 1 (single bucket).
    const rollupKeys = await scanCount(client, "rollup:*");
    expect(rollupKeys).toBeGreaterThanOrEqual(1);
    // Seen sets populated (1 risk_class set + 1 bucket set + 1 sens-type set).
    expect(await client.scard("seen:risk_class")).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!redisAvailable)("rollup count tracks N rows for a single (rc, bkt, sens) tuple", async () => {
    if (needsJson && !jsonAvailable) return;
    await client.flushall();
    // Pin every row to a single bucket so the rollup `count` field equals N
    // exactly — sanity check that pre-aggregated HINCRBYFLOAT didn't drop or
    // double-count contributions.
    const single = JSON.parse(JSON.stringify(schema));
    single.risk_classes.FX.buckets.values = ["USDEUR"];
    const gen = createRowGenerator(single, {
      seed: 22, distribution: "uniform", sensitivityTypes: ["Delta"],
    });
    const writer = createDirectWriter(client as never, {
      schema: single, storageFormat: format, batchSize: 25, hooks,
    });
    const N = 75; // forces ≥ 3 flushes at batchSize=25
    for (let i = 0; i < N; i++) await writer.add(gen.generate("FX"));
    await writer.flush();
    const count = await client.hget("rollup:{FX:USDEUR}:Delta", "count");
    expect(Number(count)).toBe(N);
  });
});

async function scanCount(c: Redis, pattern: string): Promise<number> {
  let cursor = "0";
  let total = 0;
  do {
    const [next, keys] = await c.scan(cursor, "MATCH", pattern, "COUNT", 1000);
    total += keys.length;
    cursor = next;
  } while (cursor !== "0");
  return total;
}
