import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildGirrDeltaSnippet } from "../src/girrDeltaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { computeKbDelta } from "../src/girrDeltaReference.ts";

// Spawn a local ephemeral redis-server (Redis 7+ has FUNCTION LOAD natively).
function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16411;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;
let redisAvailable = false;

// Canonical GIRR Delta weights per tenor (MAR21.42 — see config/schema/frtb-default.yaml).
const GIRR_W = [0.017, 0.017, 0.016, 0.013, 0.012, 0.011, 0.011, 0.011, 0.011, 0.011];
const GIRR_RHO = 0.99;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-delta-redis-"));
  proc = spawnRedis(PORT, tmp);
  for (let i = 0; i < 30; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      await r.ping();
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
  if (redisAvailable) {
    await redis.flushall();
    await redis.call("FUNCTION", "FLUSH").catch(() => undefined);
  }
});

async function seedDelta(
  rc: string,
  bucket: string,
  riskValue: number[],
  sensitivity_type: string = "Delta",
): Promise<string> {
  const id = ulid();
  const key = `sens:{${rc}:${bucket}}:${id}`;
  const doc = {
    risk_class: rc,
    bucket,
    sensitivity_type,
    tenor: ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"],
    risk_value: riskValue,
    weight_ref: "girr_delta_weights",
    correlation_ref: "girr_rho_kl",
  };
  await redis.set(key, JSON.stringify(doc));
  return key;
}

describe("frtb.sbm_delta_bucket (GIRR Delta Redis Function)", () => {
  it("loads as part of the locked `frtb` library", async () => {
    if (!redisAvailable) return;
    const snippet = buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("sbm_delta_bucket");

    const list = (await redis.call("FUNCTION", "LIST")) as unknown[];
    const found = JSON.stringify(list).includes("sbm_delta_bucket")
      && JSON.stringify(list).includes("frtb");
    expect(found).toBe(true);
  });

  it("coexists with Vega in the same library when both snippets are loaded", async () => {
    if (!redisAvailable) return;
    const delta = buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO });
    // Minimal Vega snippet via direct source — we don't import the Vega builder
    // because we don't want to depend on its config presence; this test just
    // proves Delta's snippet survives concatenation with another function.
    const stubVega = {
      name: "sbm_vega_bucket",
      code: "redis.register_function('sbm_vega_bucket', function(k,a) return '{\"K_b\":0}' end)\n",
    };
    const res = await loadFrtbLibrary(redis, [delta, stubVega]);
    expect(res.functionsRegistered).toContain("sbm_delta_bucket");
    expect(res.functionsRegistered).toContain("sbm_vega_bucket");
    const list = JSON.stringify(await redis.call("FUNCTION", "LIST"));
    expect(list).toContain("sbm_delta_bucket");
    expect(list).toContain("sbm_vega_bucket");
  });

  it("computes K_b for a hand-computed fixture (3 rows × 10 tenors, GIRR weights, ρ=0.99)", async () => {
    if (!redisAvailable) return;
    await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO })]);
    const rowA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const rowB = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const rowC = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    await seedDelta("GIRR", "USD", rowA);
    await seedDelta("GIRR", "USD", rowB);
    await seedDelta("GIRR", "USD", rowC);

    const raw = (await redis.call(
      "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:USD}:_", "GIRR", "USD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number; ms: number };

    const oracle = computeKbDelta(
      [
        { sensitivity_type: "Delta", risk_value: rowA },
        { sensitivity_type: "Delta", risk_value: rowB },
        { sensitivity_type: "Delta", risk_value: rowC },
      ],
      GIRR_W,
      GIRR_RHO,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(3);
    expect(typeof out.ms).toBe("number");
  });

  it("matches the TS reference oracle within 1e-9 on a randomised fixture", async () => {
    if (!redisAvailable) return;
    await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO })]);
    const rows = [
      [0.13, -0.42, 0.71, 1.05, -0.66, 0.33, -0.18, 0.92, -0.51, 0.27],
      [-0.04, 0.55, -0.31, 0.12, 0.84, -0.77, 0.46, -0.21, 0.18, -0.39],
      [0.61, 0.22, -0.18, 0.49, -0.07, 0.83, -0.65, 0.14, 0.36, -0.91],
    ];
    for (const rv of rows) await seedDelta("GIRR", "EUR", rv);
    const raw = (await redis.call(
      "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:EUR}:_", "GIRR", "EUR"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    const oracle = computeKbDelta(
      rows.map((rv) => ({ sensitivity_type: "Delta", risk_value: rv })),
      GIRR_W,
      GIRR_RHO,
    );
    expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    expect(out.count).toBe(3);
  });

  it("is slot-local: ignores rows whose hash-tag is a different bucket", async () => {
    if (!redisAvailable) return;
    await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: [1,1,1,1,1,1,1,1,1,1], rho: 0 })]);
    await seedDelta("GIRR", "USD", [1,0,0,0,0,0,0,0,0,0]);
    await seedDelta("GIRR", "USD", [0,1,0,0,0,0,0,0,0,0]);
    await seedDelta("GIRR", "EUR", [9,9,9,9,9,9,9,9,9,9]); // must not be picked up
    await seedDelta("GIRR", "GBP", [9,9,9,9,9,9,9,9,9,9]); // must not be picked up

    const raw = (await redis.call(
      "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:USD}:_", "GIRR", "USD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    // WS = [1,1,0,...]; ρ=0 → K_b = √(1²+1²) = √2; S_b = 2; count = 2
    expect(out.count).toBe(2);
    expect(out.K_b).toBeCloseTo(Math.SQRT2, 9);
    expect(out.S_b).toBeCloseTo(2, 9);
  });

  it("filters out non-Delta sensitivity rows in the same bucket", async () => {
    if (!redisAvailable) return;
    await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: [1,1,1,1,1,1,1,1,1,1], rho: 0 })]);
    await seedDelta("GIRR", "JPY", [1,0,0,0,0,0,0,0,0,0], "Delta");
    await seedDelta("GIRR", "JPY", [9,9,9,9,9,9,9,9,9,9], "Vega");
    await seedDelta("GIRR", "JPY", [9,9,9,9,9,9,9,9,9,9], "Curvature");

    const raw = (await redis.call(
      "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:JPY}:_", "GIRR", "JPY"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(1);
    expect(out.K_b).toBeCloseTo(1, 9);
    expect(out.S_b).toBeCloseTo(1, 9);
  });

  it("returns zero K_b / zero count when the bucket is empty", async () => {
    if (!redisAvailable) return;
    await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO })]);
    const raw = (await redis.call(
      "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:CHF}:_", "GIRR", "CHF"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });
});
