import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildFxDeltaSnippet } from "../src/fxDeltaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { computeKbFxDelta } from "../src/fxDeltaReference.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16414;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

const W_FX = 0.075;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-fx-delta-redis-"));
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

async function seedFx(pair: string, riskValue: number, sensitivity_type = "Delta"): Promise<string> {
  const id = ulid();
  const key = `sens:{FX:${pair}}:${id}`;
  const doc = {
    risk_class: "FX",
    bucket: pair,
    ccy_pair: pair,
    sensitivity_type,
    risk_value: riskValue,
    weight_ref: "fx_weights",
    correlation_ref: "fx_rho",
  };
  await redis.set(key, JSON.stringify(doc));
  return key;
}

describe("frtb.fx_delta (FX Delta Redis Function)", () => {
  it.skipIf(!redisAvailable)("loads as part of the `frtb` library", async () => {
    const snippet = buildFxDeltaSnippet({ weight: W_FX });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("fx_delta");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("fx_delta");
  });

  it.skipIf(!redisAvailable)("returns |w · Σs| for a multi-row currency-pair bucket", async () => {
    await loadFrtbLibrary(redis, [buildFxDeltaSnippet({ weight: W_FX })]);
    await seedFx("EURUSD", 1.0);
    await seedFx("EURUSD", 2.5);
    await seedFx("EURUSD", -0.5);

    const raw = (await redis.call(
      "FCALL", "fx_delta", "1", "sens:{FX:EURUSD}:_", "FX", "EURUSD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number; ms: number };
    const oracle = computeKbFxDelta(
      [
        { sensitivity_type: "Delta", risk_value: 1.0 },
        { sensitivity_type: "Delta", risk_value: 2.5 },
        { sensitivity_type: "Delta", risk_value: -0.5 },
      ],
      W_FX,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(3);
    expect(typeof out.ms).toBe("number");
  });

  it.skipIf(!redisAvailable)("is slot-local: ignores rows in different currency-pair buckets", async () => {
    await loadFrtbLibrary(redis, [buildFxDeltaSnippet({ weight: 1.0 })]);
    await seedFx("EURUSD", 1.0);
    await seedFx("EURUSD", 1.0);
    await seedFx("GBPUSD", 9.0);   // different bucket — must NOT be picked up
    await seedFx("USDJPY", 9.0);

    const raw = (await redis.call(
      "FCALL", "fx_delta", "1", "sens:{FX:EURUSD}:_", "FX", "EURUSD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(2);
    // Per-row formula with ρ=0 → K_b = √(1² + 1²) = √2 (S_b still sums to 2).
    expect(out.K_b).toBeCloseTo(Math.sqrt(2), 9);
    expect(out.S_b).toBeCloseTo(2.0, 9);
  });

  it.skipIf(!redisAvailable)("filters non-Delta sensitivity rows", async () => {
    await loadFrtbLibrary(redis, [buildFxDeltaSnippet({ weight: 1.0 })]);
    await seedFx("AUDUSD", 1.0, "Delta");
    await seedFx("AUDUSD", 9.0, "Vega");
    await seedFx("AUDUSD", 9.0, "Curvature");

    const raw = (await redis.call(
      "FCALL", "fx_delta", "1", "sens:{FX:AUDUSD}:_", "FX", "AUDUSD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(1.0, 9);
    expect(out.S_b).toBeCloseTo(1.0, 9);
  });

  it.skipIf(!redisAvailable)("returns zeros for an empty bucket", async () => {
    await loadFrtbLibrary(redis, [buildFxDeltaSnippet({ weight: W_FX })]);
    const raw = (await redis.call(
      "FCALL", "fx_delta", "1", "sens:{FX:NZDUSD}:_", "FX", "NZDUSD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });
});
