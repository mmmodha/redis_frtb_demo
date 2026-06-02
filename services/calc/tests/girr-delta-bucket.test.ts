import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
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

// Synchronous PATH check at module load — `it.skipIf` evaluates its condition
// at test-registration time, not at runtime, so the previous beforeAll-mutated
// flag pattern would always skip even when redis-server was available.
function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

// Canonical GIRR Delta weights per tenor (MAR21.42 — see config/schema/frtb-default.yaml).
const GIRR_W = [0.017, 0.017, 0.016, 0.013, 0.012, 0.011, 0.011, 0.011, 0.011, 0.011];
const GIRR_RHO = 0.99;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-delta-redis-"));
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

async function seedDelta(
  rc: string,
  bucket: string,
  riskValue: number[],
  sensitivity_type: string = "Delta",
  extras: { book?: string; trade_id?: string; risk_factor?: string } = {},
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
    ...extras,
  };
  await redis.set(key, JSON.stringify(doc));
  return key;
}

describe("frtb.sbm_delta_bucket (GIRR Delta Redis Function)", () => {
  it.skipIf(!redisAvailable)("loads as part of the locked `frtb` library", async () => {
    const snippet = buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("sbm_delta_bucket");

    const list = (await redis.call("FUNCTION", "LIST")) as unknown[];
    const found = JSON.stringify(list).includes("sbm_delta_bucket")
      && JSON.stringify(list).includes("frtb");
    expect(found).toBe(true);
  });

  it.skipIf(!redisAvailable)("coexists with Vega in the same library when both snippets are loaded", async () => {
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

  it.skipIf(!redisAvailable)("computes K_b for a hand-computed fixture (3 rows × 10 tenors, GIRR weights, ρ=0.99)", async () => {
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

  it.skipIf(!redisAvailable)("matches the TS reference oracle within 1e-9 on a randomised fixture", async () => {
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

  it.skipIf(!redisAvailable)("is slot-local: ignores rows whose hash-tag is a different bucket", async () => {
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

  it.skipIf(!redisAvailable)("filters out non-Delta sensitivity rows in the same bucket", async () => {
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

  it.skipIf(!redisAvailable)("returns zero K_b / zero count when the bucket is empty", async () => {
    await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO })]);
    const raw = (await redis.call(
      "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:CHF}:_", "GIRR", "CHF"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });

  // Wave 5.31c — kernel-side exclude predicate. Verifies the shared Lua
  // helpers (`_frtb_parse_csv_set` + `_frtb_excluded`) injected by the
  // library loader land in scope for every registered function and that the
  // book → trade_id → risk_factor short-circuit drops the right rows.
  describe("Wave 5.31c: exclude predicate push-down", () => {
    it.skipIf(!redisAvailable)("drops rows whose book is in the exclude_book CSV, matches the TS oracle", async () => {
      await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO })]);
      const rowA = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      const rowB = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      const rowC = [4, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      await seedDelta("GIRR", "AUD", rowA, "Delta", { book: "BookA" });
      await seedDelta("GIRR", "AUD", rowB, "Delta", { book: "BookB" });
      await seedDelta("GIRR", "AUD", rowC, "Delta", { book: "BookC" });
      const raw = (await redis.call(
        "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:AUD}:_", "GIRR", "AUD",
        "BookB", "", "",
      )) as string;
      const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
      const oracle = computeKbDelta(
        [
          { sensitivity_type: "Delta", risk_value: rowA, book: "BookA" },
          { sensitivity_type: "Delta", risk_value: rowB, book: "BookB" },
          { sensitivity_type: "Delta", risk_value: rowC, book: "BookC" },
        ],
        GIRR_W,
        GIRR_RHO,
        undefined,
        { book: new Set(["BookB"]) },
      );
      expect(out.count).toBe(2);
      expect(out.K_b).toBeCloseTo(oracle.K_b, 9);
      expect(out.S_b).toBeCloseTo(oracle.S_b, 9);
    });

    it.skipIf(!redisAvailable)("empty exclude CSVs are byte-identical to the pre-5.31c kernel (regression gate)", async () => {
      await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO })]);
      const rowA = [0.13, -0.42, 0.71, 1.05, -0.66, 0.33, -0.18, 0.92, -0.51, 0.27];
      const rowB = [-0.04, 0.55, -0.31, 0.12, 0.84, -0.77, 0.46, -0.21, 0.18, -0.39];
      await seedDelta("GIRR", "JPY", rowA);
      await seedDelta("GIRR", "JPY", rowB);
      // Pre-5.31c call shape (2 positional args).
      const rawLegacy = (await redis.call(
        "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:JPY}:_", "GIRR", "JPY"
      )) as string;
      // Post-5.31c call shape (5 positionals; 3 trailing empty CSVs).
      const rawNew = (await redis.call(
        "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:JPY}:_", "GIRR", "JPY", "", "", ""
      )) as string;
      const legacy = JSON.parse(rawLegacy) as { K_b: number; S_b: number; count: number };
      const fresh = JSON.parse(rawNew) as { K_b: number; S_b: number; count: number };
      expect(fresh.K_b).toBe(legacy.K_b);
      expect(fresh.S_b).toBe(legacy.S_b);
      expect(fresh.count).toBe(legacy.count);
    });

    it.skipIf(!redisAvailable)("trade_id and risk_factor CSVs short-circuit independently of book", async () => {
      await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: [1,1,1,1,1,1,1,1,1,1], rho: 0 })]);
      await seedDelta("GIRR", "MXN", [1,0,0,0,0,0,0,0,0,0], "Delta", { trade_id: "T1", risk_factor: "F1" });
      await seedDelta("GIRR", "MXN", [2,0,0,0,0,0,0,0,0,0], "Delta", { trade_id: "T2", risk_factor: "F2" });
      await seedDelta("GIRR", "MXN", [4,0,0,0,0,0,0,0,0,0], "Delta", { trade_id: "T3", risk_factor: "F3" });
      // Exclude T2 by trade_id; keep T1 + T3 → WS_b = 1 + 4 = 5 → K_b = 5 (ρ=0).
      const raw = (await redis.call(
        "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:MXN}:_", "GIRR", "MXN",
        "", "T2", "",
      )) as string;
      const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
      expect(out.count).toBe(2);
      expect(out.K_b).toBeCloseTo(5, 9);
      // Now exclude F1 + F3 by risk_factor → only T2 survives.
      const raw2 = (await redis.call(
        "FCALL", "sbm_delta_bucket", "1", "sens:{GIRR:MXN}:_", "GIRR", "MXN",
        "", "", "F1,F3",
      )) as string;
      const out2 = JSON.parse(raw2) as { K_b: number; S_b: number; count: number };
      expect(out2.count).toBe(1);
      expect(out2.K_b).toBeCloseTo(2, 9);
    });
  });
});
