import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import { spawnRedis, redisAvailable } from "./helpers/redis-spawn.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildGirrCurvatureSnippet } from "../src/girrCurvatureSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { resolveBucketCurvature, squareCorrelation } from "../src/curvatureCommon.ts";

const PORT = 16416;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

const TENORS = 2;
const RHO_DELTA = 0.5;
const RHO_CURV = squareCorrelation(RHO_DELTA); // ρ_curv = 0.25 per §21.5(3)

beforeAll(async () => {
  if (!redisAvailable) {
    console.warn("[girr_curvature.lua cross-check] redis-server not on PATH — Lua-side checks will be skipped.");
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-girr-curvature-redis-"));
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
  cvrUp: number[],
  cvrDown: number[],
  sensitivity_type: string = "Curvature",
): Promise<string> {
  const id = ulid();
  const key = `sens:{GIRR:${bucket}}:${id}`;
  const doc = {
    risk_class: "GIRR",
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
  rows: Array<{ cvrUp: number[]; cvrDown: number[] }>;
  // Aggregated per-tenor vectors used to drive the TS oracle directly.
  aggCvrUp: number[];
  aggCvrDown: number[];
}

const FIXTURES: Fixture[] = [
  {
    name: "F1: positive interior, single row",
    bucket: "USD",
    rows: [{ cvrUp: [1, 2], cvrDown: [-0.5, -1] }],
    aggCvrUp: [1, 2], aggCvrDown: [-0.5, -1],
  },
  {
    name: "F2: same-direction mixed-sign (verifier gap fix)",
    bucket: "EUR",
    rows: [{ cvrUp: [2, -1], cvrDown: [-0.5, 1.5] }],
    aggCvrUp: [2, -1], aggCvrDown: [-0.5, 1.5],
  },
  {
    name: "F3: multi-row per-tenor aggregation",
    bucket: "GBP",
    rows: [
      { cvrUp: [0.5, 1.0], cvrDown: [-0.25, -0.5] },
      { cvrUp: [0.5, 1.0], cvrDown: [-0.25, -0.5] },
    ],
    aggCvrUp: [1, 2], aggCvrDown: [-0.5, -1],
  },
  {
    name: "F4: both directions both-negative ⇒ ψ=0 branch",
    bucket: "JPY",
    rows: [{ cvrUp: [-3, -3], cvrDown: [-2, -1] }],
    aggCvrUp: [-3, -3], aggCvrDown: [-2, -1],
  },
  {
    name: "F5: down winner, asymmetric magnitudes",
    bucket: "CHF",
    rows: [{ cvrUp: [0.1, 0.2], cvrDown: [3, 2] }],
    aggCvrUp: [0.1, 0.2], aggCvrDown: [3, 2],
  },
];

describe("frtb.girr_curvature (GIRR Curvature Redis Function) cross-check vs TS oracle", () => {
  it.skipIf(!redisAvailable)("loads as part of the `frtb` library and registers girr_curvature", async () => {
    const snippet = buildGirrCurvatureSnippet({ tenors: TENORS, rho: RHO_CURV });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("girr_curvature");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("girr_curvature");
    expect(list).toContain("frtb");
  });

  for (const fx of FIXTURES) {
    it.skipIf(!redisAvailable)(`agrees with the TS oracle to ±1e-9 on ${fx.name}`, async () => {
      await loadFrtbLibrary(redis, [buildGirrCurvatureSnippet({ tenors: TENORS, rho: RHO_CURV })]);
      for (const row of fx.rows) await seedCurvature(fx.bucket, row.cvrUp, row.cvrDown);
      const raw = (await redis.call(
        "FCALL", "girr_curvature", "1", `sens:{GIRR:${fx.bucket}}:_`, "GIRR", fx.bucket,
      )) as string;
      const lua = JSON.parse(raw) as LuaOut;
      const ts = resolveBucketCurvature(fx.bucket, fx.aggCvrUp, fx.aggCvrDown, RHO_CURV, fx.rows.length);
      expect(lua.K_b).toBeCloseTo(ts.K_b, 9);
      expect(lua.K_b_up).toBeCloseTo(ts.K_b_up, 9);
      expect(lua.K_b_down).toBeCloseTo(ts.K_b_down, 9);
      expect(lua.S_b).toBeCloseTo(ts.S_b, 9);
      expect(lua.direction).toBe(ts.direction);
      expect(lua.count).toBe(fx.rows.length);
    });
  }

  it.skipIf(!redisAvailable)("filters out non-Curvature sensitivity rows in the same bucket", async () => {
    await loadFrtbLibrary(redis, [buildGirrCurvatureSnippet({ tenors: TENORS, rho: 0 })]);
    await seedCurvature("AUD", [1, 0], [-1, 0], "Curvature");
    await seedCurvature("AUD", [9, 9], [9, 9], "Delta");
    await seedCurvature("AUD", [9, 9], [9, 9], "Vega");
    const raw = (await redis.call(
      "FCALL", "girr_curvature", "1", "sens:{GIRR:AUD}:_", "GIRR", "AUD",
    )) as string;
    const out = JSON.parse(raw) as LuaOut;
    expect(out.count).toBe(1);
    expect(out.K_b_up).toBeCloseTo(1, 9);
    expect(out.K_b_down).toBeCloseTo(1, 9);
    expect(out.K_b).toBeCloseTo(1, 9);
  });

  it.skipIf(!redisAvailable)("returns zeros for an empty bucket", async () => {
    await loadFrtbLibrary(redis, [buildGirrCurvatureSnippet({ tenors: TENORS, rho: RHO_CURV })]);
    const raw = (await redis.call(
      "FCALL", "girr_curvature", "1", "sens:{GIRR:CAD}:_", "GIRR", "CAD",
    )) as string;
    const out = JSON.parse(raw) as LuaOut;
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });
});
