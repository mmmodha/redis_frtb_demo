import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildEquityDeltaSnippet } from "../src/equityDeltaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { computeKbEquityDelta } from "../src/equityDeltaReference.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16412;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

// Equity bucket → weight from config/schema/frtb-default.yaml (equity_weights.by_bucket).
const EQUITY_W = {
  "1": 0.55, "2": 0.60, "3": 0.45, "4": 0.55, "5": 0.30,
  "6": 0.35, "7": 0.40, "8": 0.50, "9": 0.70, "10": 0.50,
  "11": 0.70, "12": 0.15, "13": 0.25,
} as const;
const EQUITY_RHO = 0.50;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-equity-delta-redis-"));
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
  if (redisAvailable) {
    await redis.flushall();
    await redis.call("FUNCTION", "FLUSH").catch(() => undefined);
  }
});

async function seedEquity(
  bucket: string,
  riskValue: number,
  sensitivity_type: string = "Delta",
): Promise<string> {
  const id = ulid();
  const key = `sens:{Equity:${bucket}}:${id}`;
  const doc = {
    risk_class: "Equity",
    bucket,
    sensitivity_type,
    risk_value: riskValue,
    weight_ref: "equity_weights",
    correlation_ref: "equity_rho",
  };
  await redis.set(key, JSON.stringify(doc));
  return key;
}

describe("frtb.equity_delta (Equity Delta Redis Function)", () => {
  it.skipIf(!redisAvailable)("loads as part of the `frtb` library and registers equity_delta", async () => {
    const snippet = buildEquityDeltaSnippet({ weights: EQUITY_W, rho: EQUITY_RHO });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("equity_delta");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("equity_delta");
    expect(list).toContain("frtb");
  });

  it.skipIf(!redisAvailable)("computes K_b for a hand-computed 3-row fixture in bucket 1 (w=0.55, ρ=0.5)", async () => {
    await loadFrtbLibrary(redis, [buildEquityDeltaSnippet({ weights: EQUITY_W, rho: EQUITY_RHO })]);
    await seedEquity("1", 1.0);
    await seedEquity("1", 2.0);
    await seedEquity("1", -0.5);

    const raw = (await redis.call(
      "FCALL", "equity_delta", "1", "sens:{Equity:1}:_", "Equity", "1"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number; ms: number };

    const oracle = computeKbEquityDelta(
      [
        { sensitivity_type: "Delta", risk_value: 1.0 },
        { sensitivity_type: "Delta", risk_value: 2.0 },
        { sensitivity_type: "Delta", risk_value: -0.5 },
      ],
      EQUITY_W["1"],
      EQUITY_RHO,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(3);
    expect(typeof out.ms).toBe("number");
  });

  it.skipIf(!redisAvailable)("uses the bucket-specific weight (bucket 9, w=0.70)", async () => {
    await loadFrtbLibrary(redis, [buildEquityDeltaSnippet({ weights: EQUITY_W, rho: 0 })]);
    await seedEquity("9", 1.0);
    await seedEquity("9", 1.0);

    const raw = (await redis.call(
      "FCALL", "equity_delta", "1", "sens:{Equity:9}:_", "Equity", "9"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    // WS = [0.7, 0.7], ρ=0 → K_b = √(0.49 + 0.49) = √0.98
    expect(out.K_b).toBeCloseTo(Math.sqrt(0.98), 9);
    expect(out.S_b).toBeCloseTo(1.4, 9);
    expect(out.count).toBe(2);
  });

  it.skipIf(!redisAvailable)("is slot-local: ignores rows in different buckets", async () => {
    await loadFrtbLibrary(redis, [buildEquityDeltaSnippet({ weights: EQUITY_W, rho: 0 })]);
    await seedEquity("1", 1.0);
    await seedEquity("1", 1.0);
    await seedEquity("2", 9.0);   // different bucket — must NOT be picked up
    await seedEquity("13", 9.0);  // different bucket — must NOT be picked up

    const raw = (await redis.call(
      "FCALL", "equity_delta", "1", "sens:{Equity:1}:_", "Equity", "1"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(2);
    // WS = [0.55, 0.55], ρ=0 → K_b = √(0.605)
    expect(out.K_b).toBeCloseTo(Math.sqrt(2 * 0.55 * 0.55), 9);
    expect(out.S_b).toBeCloseTo(1.10, 9);
  });

  it.skipIf(!redisAvailable)("filters out non-Delta sensitivity rows", async () => {
    await loadFrtbLibrary(redis, [buildEquityDeltaSnippet({ weights: EQUITY_W, rho: 0 })]);
    await seedEquity("3", 1.0, "Delta");
    await seedEquity("3", 9.0, "Vega");
    await seedEquity("3", 9.0, "Curvature");

    const raw = (await redis.call(
      "FCALL", "equity_delta", "1", "sens:{Equity:3}:_", "Equity", "3"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(EQUITY_W["3"], 9);
  });

  it.skipIf(!redisAvailable)("returns zeros for an empty bucket", async () => {
    await loadFrtbLibrary(redis, [buildEquityDeltaSnippet({ weights: EQUITY_W, rho: EQUITY_RHO })]);
    const raw = (await redis.call(
      "FCALL", "equity_delta", "1", "sens:{Equity:5}:_", "Equity", "5"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });
});
