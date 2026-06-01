// Wave 5.17a — Lua-vs-TS cross-check for the NEW per-(class × sens_type)
// risk_value object shape.
//
// Pre-existing bucket tests (`*-bucket.test.ts`, `*-reference.test.ts`)
// already exercise the legacy array / scalar shape; this suite locks in:
//   (1) Lua kernels read the new object shape correctly;
//   (2) TS oracles read the new object shape correctly;
//   (3) Both produce IDENTICAL K_b / S_b on a hand-computed object-shape
//       fixture; if either drifts, this test fails fast.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildGirrDeltaSnippet } from "../src/girrDeltaSnippet.ts";
import { buildGirrVegaSnippet } from "../src/girrVegaSnippet.ts";
import { buildEquityDeltaSnippet } from "../src/equityDeltaSnippet.ts";
import { buildEquityVegaSnippet } from "../src/equityVegaSnippet.ts";
import { buildFxDeltaSnippet } from "../src/fxDeltaSnippet.ts";
import { buildFxVegaSnippet } from "../src/fxVegaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { computeKbDelta } from "../src/girrDeltaReference.ts";
import { computeKbVega } from "../src/girrVegaReference.ts";
import { computeKbEquityDelta } from "../src/equityDeltaReference.ts";
import { computeKbEquityVega } from "../src/equityVegaReference.ts";
import { computeKbFxDelta } from "../src/fxDeltaReference.ts";
import { computeKbFxVega } from "../src/fxVegaReference.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}
function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

const PORT = 16450;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

const TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"];
const GIRR_W = [0.017, 0.017, 0.016, 0.013, 0.012, 0.011, 0.011, 0.011, 0.011, 0.011];
const GIRR_RHO = 0.99;
const GIRR_VEGA_W = 1.0;
const GIRR_VEGA_RHO = 0.5;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-object-shape-"));
  proc = spawnRedis(PORT, tmp);
  for (let i = 0; i < 30; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect(); await r.ping(); await r.quit();
      redis = new Redis({ port: PORT });
      return;
    } catch { await wait(100); }
  }
  throw new Error("redis-server failed to start");
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

async function seedJson(rc: string, bucket: string, doc: Record<string, unknown>): Promise<void> {
  const key = `sens:{${rc}:${bucket}}:${ulid()}`;
  await redis.set(key, JSON.stringify(doc));
}
const objFromTenors = (vals: number[]): Record<string, number> =>
  Object.fromEntries(vals.map((v, i) => [TENORS[i]!, v]));

describe("Wave 5.17a — Lua-vs-TS cross-check on the NEW per-(class × sens_type) object risk_value shape", () => {
  it.skipIf(!redisAvailable)("GIRR Delta: per-tenor object risk_value → Lua K_b matches TS oracle within 1e-9", async () => {
    await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO, tenors: TENORS })]);
    const rows = [
      [0.13, -0.42, 0.71, 1.05, -0.66, 0.33, -0.18, 0.92, -0.51, 0.27],
      [-0.04, 0.55, -0.31, 0.12, 0.84, -0.77, 0.46, -0.21, 0.18, -0.39],
      [0.61, 0.22, -0.18, 0.49, -0.07, 0.83, -0.65, 0.14, 0.36, -0.91],
    ];
    for (const rv of rows) await seedJson("GIRR", "EUR", { risk_class: "GIRR", bucket: "EUR", sensitivity_type: "Delta", risk_value: objFromTenors(rv) });
    const raw = (await redis.call("FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:EUR}:_", "GIRR", "EUR")) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    const oracle = computeKbDelta(
      rows.map((rv) => ({ sensitivity_type: "Delta", risk_value: objFromTenors(rv) })),
      GIRR_W, GIRR_RHO, TENORS,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(3);
  });

  it.skipIf(!redisAvailable)("GIRR Vega: per-tenor object risk_value → Lua K_b matches TS oracle within 1e-9", async () => {
    await loadFrtbLibrary(redis, [buildGirrVegaSnippet({ weight: GIRR_VEGA_W, rho: GIRR_VEGA_RHO, tenors: TENORS })]);
    const rows = [
      [0.5, 1.0, -0.3, 0.2, 0.7, -0.4, 0.1, -0.2, 0.6, -0.9],
      [-0.1, 0.4, 0.8, -0.5, 0.3, 0.2, -0.7, 0.6, 0.1, 0.4],
    ];
    for (const rv of rows) await seedJson("GIRR", "USD", { risk_class: "GIRR", bucket: "USD", sensitivity_type: "Vega", risk_value: objFromTenors(rv) });
    const raw = (await redis.call("FCALL", "sbm_vega_bucket", "1", "sens:{GIRR:USD}:_", "GIRR", "USD")) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    const oracle = computeKbVega(
      rows.map((rv) => objFromTenors(rv)),
      GIRR_VEGA_W, GIRR_VEGA_RHO, TENORS,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(2);
  });

  it.skipIf(!redisAvailable)("Equity Delta / Vega: { spot } risk_value → Lua matches TS oracle within 1e-9", async () => {
    await loadFrtbLibrary(redis, [
      buildEquityDeltaSnippet({ weights: { "1": 0.55 }, rho: 0.5 }),
      buildEquityVegaSnippet({ weight: 1.0, rho: 0.5 }),
    ]);
    const dRows = [{ spot: 1.0 }, { spot: 2.0 }, { spot: -0.5 }];
    const vRows = [{ spot: 0.5 }, { spot: 1.0 }];
    for (const rv of dRows) await seedJson("Equity", "1", { risk_class: "Equity", bucket: "1", sensitivity_type: "Delta", risk_value: rv });
    for (const rv of vRows) await seedJson("Equity", "1", { risk_class: "Equity", bucket: "1", sensitivity_type: "Vega", risk_value: rv });
    const rawD = JSON.parse((await redis.call("FCALL", "equity_delta", "1", "sens:{Equity:1}:_", "Equity", "1")) as string);
    const rawV = JSON.parse((await redis.call("FCALL", "equity_vega", "1", "sens:{Equity:1}:_", "Equity", "1")) as string);
    const orD = computeKbEquityDelta(dRows.map((rv) => ({ sensitivity_type: "Delta", risk_value: rv })), 0.55, 0.5);
    const orV = computeKbEquityVega(vRows.map((rv) => ({ sensitivity_type: "Vega", risk_value: rv })), 1.0, 0.5);
    expect(rawD.K_b).toBeCloseTo(orD.K_b, 9);
    expect(rawV.K_b).toBeCloseTo(orV.K_b, 9);
  });

  it.skipIf(!redisAvailable)("FX Delta / Vega: { spot } risk_value → Lua matches TS oracle within 1e-9", async () => {
    await loadFrtbLibrary(redis, [
      buildFxDeltaSnippet({ weight: 0.075, rho: 0.6 }),
      buildFxVegaSnippet({ weight: 1.0, rho: 0.6 }),
    ]);
    const dRows = [{ spot: 1.5 }, { spot: -0.8 }, { spot: 0.3 }];
    const vRows = [{ spot: 0.4 }, { spot: 0.9 }];
    for (const rv of dRows) await seedJson("FX", "USDEUR", { risk_class: "FX", bucket: "USDEUR", sensitivity_type: "Delta", risk_value: rv });
    for (const rv of vRows) await seedJson("FX", "USDEUR", { risk_class: "FX", bucket: "USDEUR", sensitivity_type: "Vega", risk_value: rv });
    const rawD = JSON.parse((await redis.call("FCALL", "fx_delta", "1", "sens:{FX:USDEUR}:_", "FX", "USDEUR")) as string);
    const rawV = JSON.parse((await redis.call("FCALL", "fx_vega", "1", "sens:{FX:USDEUR}:_", "FX", "USDEUR")) as string);
    const orD = computeKbFxDelta(dRows.map((rv) => ({ sensitivity_type: "Delta", risk_value: rv })), 0.075, 0.6);
    const orV = computeKbFxVega(vRows.map((rv) => ({ sensitivity_type: "Vega", risk_value: rv })), 1.0, 0.6);
    expect(rawD.K_b).toBeCloseTo(orD.K_b, 9);
    expect(rawV.K_b).toBeCloseTo(orV.K_b, 9);
  });
});
