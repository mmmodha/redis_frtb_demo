import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildFxVegaSnippet } from "../src/fxVegaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { computeKbFxVega } from "../src/fxVegaReference.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16415;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

const W_FX_VEGA = 1.0;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-fx-vega-redis-"));
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

async function seedFxVega(pair: string, riskValue: number, sensitivity_type = "Vega"): Promise<string> {
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

describe("frtb.fx_vega (FX Vega Redis Function)", () => {
  it.skipIf(!redisAvailable)("loads as part of the `frtb` library", async () => {
    const snippet = buildFxVegaSnippet({ weight: W_FX_VEGA });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("fx_vega");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("fx_vega");
  });

  it.skipIf(!redisAvailable)("returns |w · Σs| over Vega rows only", async () => {
    await loadFrtbLibrary(redis, [buildFxVegaSnippet({ weight: W_FX_VEGA })]);
    await seedFxVega("EURUSD", 0.4);
    await seedFxVega("EURUSD", 0.6);
    await seedFxVega("EURUSD", 99, "Delta"); // filtered

    const raw = (await redis.call(
      "FCALL", "fx_vega", "1", "sens:{FX:EURUSD}:_", "FX", "EURUSD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    const oracle = computeKbFxVega(
      [
        { sensitivity_type: "Vega", risk_value: 0.4 },
        { sensitivity_type: "Vega", risk_value: 0.6 },
      ],
      W_FX_VEGA,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(2);
  });

  it.skipIf(!redisAvailable)("returns zeros for an empty bucket", async () => {
    await loadFrtbLibrary(redis, [buildFxVegaSnippet({ weight: W_FX_VEGA })]);
    const raw = (await redis.call(
      "FCALL", "fx_vega", "1", "sens:{FX:USDCHF}:_", "FX", "USDCHF"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
  });
});
