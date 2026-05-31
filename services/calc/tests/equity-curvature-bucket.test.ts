import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildEquityCurvatureSnippet } from "../src/equityCurvatureSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { resolveBucketCurvature, squareCorrelation } from "../src/curvatureCommon.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" },
  );
}

const PORT = 16417;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

const RHO_DELTA = 0.5;
const RHO_CURV = squareCorrelation(RHO_DELTA);

beforeAll(async () => {
  if (!redisAvailable) {
    console.warn("[equity_curvature.lua cross-check] redis-server not on PATH — Lua-side checks will be skipped.");
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-equity-curvature-redis-"));
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

async function seedCurvature(
  bucket: string,
  cvrUp: number,
  cvrDown: number,
  sensitivity_type: string = "Curvature",
): Promise<string> {
  const id = ulid();
  const key = `sens:{Equity:${bucket}}:${id}`;
  const doc = {
    risk_class: "Equity",
    bucket,
    sensitivity_type,
    risk_value: { cvr_up: cvrUp, cvr_down: cvrDown },
  };
  await redis.set(key, JSON.stringify(doc));
  return key;
}

interface LuaOut {
  K_b: number; K_b_up: number; K_b_down: number;
  S_b: number; S_b_up: number; S_b_down: number;
  direction: "up" | "down" | "tie";
  count: number;
  ms: number;
}

interface Fixture {
  name: string;
  bucket: string;
  rows: Array<{ cvrUp: number; cvrDown: number }>;
}

const FIXTURES: Fixture[] = [
  {
    name: "F1: positive interior, two issuer factors",
    bucket: "1",
    rows: [
      { cvrUp: 1, cvrDown: -0.5 },
      { cvrUp: 2, cvrDown: -1 },
    ],
  },
  {
    name: "F2: same-direction mixed-sign (verifier gap fix)",
    bucket: "2",
    rows: [
      { cvrUp: 2, cvrDown: -0.5 },
      { cvrUp: -1, cvrDown: 1.5 },
    ],
  },
  {
    name: "F3: both directions both-negative ⇒ ψ=0 branch",
    bucket: "3",
    rows: [
      { cvrUp: -3, cvrDown: -2 },
      { cvrUp: -3, cvrDown: -1 },
    ],
  },
  {
    name: "F4: down winner, asymmetric magnitudes",
    bucket: "4",
    rows: [
      { cvrUp: 0.1, cvrDown: 3 },
      { cvrUp: 0.2, cvrDown: 2 },
    ],
  },
  {
    name: "F5: three issuer factors, mixed sign up direction",
    bucket: "5",
    rows: [
      { cvrUp: 1.5, cvrDown: -0.5 },
      { cvrUp: -0.5, cvrDown: 0.25 },
      { cvrUp: 2.0, cvrDown: -1.0 },
    ],
  },
];

describe("frtb.equity_curvature (Equity Curvature Redis Function) cross-check vs TS oracle", () => {
  it.skipIf(!redisAvailable)("loads as part of the `frtb` library and registers equity_curvature", async () => {
    const snippet = buildEquityCurvatureSnippet({ rho: RHO_CURV });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("equity_curvature");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("equity_curvature");
    expect(list).toContain("frtb");
  });

  for (const fx of FIXTURES) {
    it.skipIf(!redisAvailable)(`agrees with the TS oracle to ±1e-9 on ${fx.name}`, async () => {
      await loadFrtbLibrary(redis, [buildEquityCurvatureSnippet({ rho: RHO_CURV })]);
      for (const row of fx.rows) await seedCurvature(fx.bucket, row.cvrUp, row.cvrDown);
      const raw = (await redis.call(
        "FCALL", "equity_curvature", "1", `sens:{Equity:${fx.bucket}}:_`, "Equity", fx.bucket,
      )) as string;
      const lua = JSON.parse(raw) as LuaOut;
      const aggUp = fx.rows.map((r) => r.cvrUp);
      const aggDown = fx.rows.map((r) => r.cvrDown);
      const ts = resolveBucketCurvature(fx.bucket, aggUp, aggDown, RHO_CURV, fx.rows.length);
      expect(lua.K_b).toBeCloseTo(ts.K_b, 9);
      expect(lua.K_b_up).toBeCloseTo(ts.K_b_up, 9);
      expect(lua.K_b_down).toBeCloseTo(ts.K_b_down, 9);
      // S_b is sum-invariant under row order, so no scan-order dependence.
      expect(lua.S_b).toBeCloseTo(ts.S_b, 9);
      expect(lua.direction).toBe(ts.direction);
      expect(lua.count).toBe(fx.rows.length);
    });
  }

  it.skipIf(!redisAvailable)("filters out non-Curvature sensitivity rows in the same bucket", async () => {
    await loadFrtbLibrary(redis, [buildEquityCurvatureSnippet({ rho: 0 })]);
    await seedCurvature("9", 1, -1, "Curvature");
    await seedCurvature("9", 9, 9, "Delta");
    await seedCurvature("9", 9, 9, "Vega");
    const raw = (await redis.call(
      "FCALL", "equity_curvature", "1", "sens:{Equity:9}:_", "Equity", "9",
    )) as string;
    const out = JSON.parse(raw) as LuaOut;
    expect(out.count).toBe(1);
    expect(out.K_b_up).toBeCloseTo(1, 9);
    expect(out.K_b_down).toBeCloseTo(1, 9);
  });

  it.skipIf(!redisAvailable)("returns zeros for an empty bucket", async () => {
    await loadFrtbLibrary(redis, [buildEquityCurvatureSnippet({ rho: RHO_CURV })]);
    const raw = (await redis.call(
      "FCALL", "equity_curvature", "1", "sens:{Equity:11}:_", "Equity", "11",
    )) as string;
    const out = JSON.parse(raw) as LuaOut;
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });
});
