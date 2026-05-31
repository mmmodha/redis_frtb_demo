import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildFxCurvatureSnippet } from "../src/fxCurvatureSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { resolveBucketCurvature, squareCorrelation } from "../src/curvatureCommon.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" },
  );
}

const PORT = 16418;
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
    console.warn("[fx_curvature.lua cross-check] redis-server not on PATH — Lua-side checks will be skipped.");
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-fx-curvature-redis-"));
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
  const key = `sens:{FX:${bucket}}:${id}`;
  const doc = {
    risk_class: "FX",
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
    name: "F1: positive interior, two FX factors",
    bucket: "EURUSD",
    rows: [
      { cvrUp: 1, cvrDown: -0.5 },
      { cvrUp: 2, cvrDown: -1 },
    ],
  },
  {
    name: "F2: same-direction mixed-sign (verifier gap fix)",
    bucket: "GBPUSD",
    rows: [
      { cvrUp: 2, cvrDown: -0.5 },
      { cvrUp: -1, cvrDown: 1.5 },
    ],
  },
  {
    name: "F3: both directions both-negative ⇒ ψ=0 branch",
    bucket: "JPYUSD",
    rows: [
      { cvrUp: -3, cvrDown: -2 },
      { cvrUp: -3, cvrDown: -1 },
    ],
  },
  {
    name: "F4: down winner, asymmetric magnitudes",
    bucket: "CHFUSD",
    rows: [
      { cvrUp: 0.1, cvrDown: 3 },
      { cvrUp: 0.2, cvrDown: 2 },
    ],
  },
  {
    name: "F5: single FX factor (fxDelta single-factor convention)",
    bucket: "AUDUSD",
    rows: [{ cvrUp: 3, cvrDown: -4 }],
  },
];

describe("frtb.fx_curvature (FX Curvature Redis Function) cross-check vs TS oracle", () => {
  it.skipIf(!redisAvailable)("loads as part of the `frtb` library and registers fx_curvature", async () => {
    const snippet = buildFxCurvatureSnippet({ rho: RHO_CURV });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("fx_curvature");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("fx_curvature");
    expect(list).toContain("frtb");
  });

  for (const fx of FIXTURES) {
    it.skipIf(!redisAvailable)(`agrees with the TS oracle to ±1e-9 on ${fx.name}`, async () => {
      await loadFrtbLibrary(redis, [buildFxCurvatureSnippet({ rho: RHO_CURV })]);
      for (const row of fx.rows) await seedCurvature(fx.bucket, row.cvrUp, row.cvrDown);
      const raw = (await redis.call(
        "FCALL", "fx_curvature", "1", `sens:{FX:${fx.bucket}}:_`, "FX", fx.bucket,
      )) as string;
      const lua = JSON.parse(raw) as LuaOut;
      const aggUp = fx.rows.map((r) => r.cvrUp);
      const aggDown = fx.rows.map((r) => r.cvrDown);
      const ts = resolveBucketCurvature(fx.bucket, aggUp, aggDown, RHO_CURV, fx.rows.length);
      expect(lua.K_b).toBeCloseTo(ts.K_b, 9);
      expect(lua.K_b_up).toBeCloseTo(ts.K_b_up, 9);
      expect(lua.K_b_down).toBeCloseTo(ts.K_b_down, 9);
      expect(lua.S_b).toBeCloseTo(ts.S_b, 9);
      expect(lua.direction).toBe(ts.direction);
      expect(lua.count).toBe(fx.rows.length);
    });
  }

  it.skipIf(!redisAvailable)("filters out non-Curvature sensitivity rows in the same bucket", async () => {
    await loadFrtbLibrary(redis, [buildFxCurvatureSnippet({ rho: 0 })]);
    await seedCurvature("NZDUSD", 1, -1, "Curvature");
    await seedCurvature("NZDUSD", 9, 9, "Delta");
    await seedCurvature("NZDUSD", 9, 9, "Vega");
    const raw = (await redis.call(
      "FCALL", "fx_curvature", "1", "sens:{FX:NZDUSD}:_", "FX", "NZDUSD",
    )) as string;
    const out = JSON.parse(raw) as LuaOut;
    expect(out.count).toBe(1);
    expect(out.K_b_up).toBeCloseTo(1, 9);
    expect(out.K_b_down).toBeCloseTo(1, 9);
  });

  it.skipIf(!redisAvailable)("returns zeros for an empty bucket", async () => {
    await loadFrtbLibrary(redis, [buildFxCurvatureSnippet({ rho: RHO_CURV })]);
    const raw = (await redis.call(
      "FCALL", "fx_curvature", "1", "sens:{FX:CADUSD}:_", "FX", "CADUSD",
    )) as string;
    const out = JSON.parse(raw) as LuaOut;
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });

  it.skipIf(!redisAvailable)("defaults ρ_curv to 0 when omitted (single-factor specialisation)", async () => {
    await loadFrtbLibrary(redis, [buildFxCurvatureSnippet()]);
    await seedCurvature("SGDUSD", 3, -4);
    const raw = (await redis.call(
      "FCALL", "fx_curvature", "1", "sens:{FX:SGDUSD}:_", "FX", "SGDUSD",
    )) as string;
    const out = JSON.parse(raw) as LuaOut;
    // Single factor ⇒ no cross term. K_b_up=3, K_b_down=4, K_b=4, S_b=-4.
    expect(out.K_b_up).toBeCloseTo(3, 9);
    expect(out.K_b_down).toBeCloseTo(4, 9);
    expect(out.K_b).toBeCloseTo(4, 9);
    expect(out.direction).toBe("down");
    expect(out.S_b).toBeCloseTo(-4, 9);
  });
});
