import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import { spawnRedis, redisAvailable } from "./helpers/redis-spawn.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildEquityVegaSnippet } from "../src/equityVegaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { computeKbEquityVega } from "../src/equityVegaReference.ts";

const PORT = 16413;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

const EQUITY_VEGA_W = 1.0; // PoV representative constant
const EQUITY_RHO = 0.50;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-equity-vega-redis-"));
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

async function seedEquityVega(bucket: string, riskValue: number, sensitivity_type = "Vega"): Promise<string> {
  const id = ulid();
  const key = `sens:{Equity:${bucket}}:${id}`;
  const doc = {
    risk_class: "Equity",
    bucket,
    sensitivity_type,
    risk_value: riskValue,
    weight_ref: "equity_vega_weights",
    correlation_ref: "equity_rho",
  };
  await redis.set(key, JSON.stringify(doc));
  return key;
}

describe("frtb.equity_vega (Equity Vega Redis Function)", () => {
  it.skipIf(!redisAvailable)("loads as part of the `frtb` library", async () => {
    const snippet = buildEquityVegaSnippet({ weight: EQUITY_VEGA_W, rho: EQUITY_RHO });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("equity_vega");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("equity_vega");
  });

  it.skipIf(!redisAvailable)("computes K_b for a hand-computed 2-row vega fixture (w=1, ρ=0.5)", async () => {
    await loadFrtbLibrary(redis, [buildEquityVegaSnippet({ weight: 1.0, rho: 0.5 })]);
    await seedEquityVega("1", 0.5);
    await seedEquityVega("1", 1.0);

    const raw = (await redis.call(
      "FCALL", "equity_vega", "1", "sens:{Equity:1}:_", "Equity", "1"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    const oracle = computeKbEquityVega(
      [
        { sensitivity_type: "Vega", risk_value: 0.5 },
        { sensitivity_type: "Vega", risk_value: 1.0 },
      ],
      1.0, 0.5,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(2);
  });

  it.skipIf(!redisAvailable)("filters out Delta and Curvature rows", async () => {
    await loadFrtbLibrary(redis, [buildEquityVegaSnippet({ weight: 1.0, rho: 0 })]);
    await seedEquityVega("4", 1.0, "Vega");
    await seedEquityVega("4", 9.0, "Delta");
    await seedEquityVega("4", 9.0, "Curvature");

    const raw = (await redis.call(
      "FCALL", "equity_vega", "1", "sens:{Equity:4}:_", "Equity", "4"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(1.0, 9);
  });

  it.skipIf(!redisAvailable)("returns zeros for an empty bucket", async () => {
    await loadFrtbLibrary(redis, [buildEquityVegaSnippet({ weight: EQUITY_VEGA_W, rho: EQUITY_RHO })]);
    const raw = (await redis.call(
      "FCALL", "equity_vega", "1", "sens:{Equity:7}:_", "Equity", "7"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
  });
});
