import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { buildGirrVegaSnippet } from "../src/girrVegaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";
import { computeKbVega } from "../src/girrVegaReference.ts";

// Spawn a local ephemeral redis-server (Redis 7+ has FUNCTION LOAD natively).
function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16410;
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

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-redis-"));
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

async function seedRow(rc: string, bucket: string, riskValue: number[]): Promise<string> {
  const id = ulid();
  const key = `sens:{${rc}:${bucket}}:${id}`;
  const doc = {
    risk_class: rc,
    bucket,
    sensitivity_type: "Vega",
    tenor: [1, 5],
    risk_value: riskValue,
    weight_ref: "girr_vega_weights",
    correlation_ref: "girr_vega_rho_kl",
  };
  // Plain string SET — these tests run against a vanilla redis-server (no
  // ReJSON module). The per-bucket Lua functions transparently fall back to
  // GET when JSON.GET is unavailable, so the test stays representative of
  // the bucket-K_b math.
  await redis.set(key, JSON.stringify(doc));
  return key;
}

describe("frtb.sbm_vega_bucket (GIRR Vega Redis Function)", () => {
  it.skipIf(!redisAvailable)("loads as part of the locked `frtb` library", async () => {
    const snippet = buildGirrVegaSnippet({ weight: 1.0, rho: 0.5 });
    const result = await loadFrtbLibrary(redis, [snippet]);
    expect(result.libraryName).toBe("frtb");
    expect(result.functionsRegistered).toContain("sbm_vega_bucket");

    // FUNCTION LIST should report library `frtb` and function `sbm_vega_bucket`
    const list = (await redis.call("FUNCTION", "LIST")) as unknown[];
    const found = JSON.stringify(list).includes("sbm_vega_bucket")
      && JSON.stringify(list).includes("frtb");
    expect(found).toBe(true);
  });

  it.skipIf(!redisAvailable)("computes K_b for a hand-computed fixture (w=1, ρ=0.5, 2 rows × 2 tenors)", async () => {
    await loadFrtbLibrary(redis, [buildGirrVegaSnippet({ weight: 1.0, rho: 0.5 })]);
    await seedRow("GIRR", "USD", [0.5, 1.0]);
    await seedRow("GIRR", "USD", [1.0, 0.5]);

    const raw = (await redis.call(
      "FCALL", "sbm_vega_bucket", "1", "sens:{GIRR:USD}:_", "GIRR", "USD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number; ms: number };

    // Hand-computed: WS=[0.5,1.0,1.0,0.5], ΣWS²=2.5, (ΣWS)²=9, K_b²=2.5 + 0.5·(9−2.5)=5.75
    expect(out.K_b).toBeCloseTo(Math.sqrt(5.75), 9);
    expect(out.S_b).toBeCloseTo(3.0, 9);
    expect(out.count).toBe(2);
    expect(typeof out.ms).toBe("number");
  });

  it.skipIf(!redisAvailable)("matches the TS reference oracle on a 1-row fixture (w=0.18, ρ=0.4)", async () => {
    const weight = 0.18;
    const rho = 0.4;
    await loadFrtbLibrary(redis, [buildGirrVegaSnippet({ weight, rho })]);
    const rv = [0.7, 1.3];
    await seedRow("GIRR", "EUR", rv);

    const raw = (await redis.call(
      "FCALL", "sbm_vega_bucket", "1", "sens:{GIRR:EUR}:_", "GIRR", "EUR"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    const oracle = computeKbVega([rv], weight, rho);

    expect(out.K_b).toBeCloseTo(oracle.K_b, 10);
    expect(out.S_b).toBeCloseTo(oracle.S_b, 10);
    expect(out.count).toBe(1);
  });

  it.skipIf(!redisAvailable)("is slot-local: ignores rows whose hash-tag is a different bucket", async () => {
    await loadFrtbLibrary(redis, [buildGirrVegaSnippet({ weight: 1.0, rho: 0.0 })]);
    await seedRow("GIRR", "USD", [1.0, 1.0]); // target bucket
    await seedRow("GIRR", "USD", [1.0, 1.0]); // target bucket
    await seedRow("GIRR", "EUR", [9.0, 9.0]); // different bucket — must NOT be picked up
    await seedRow("GIRR", "GBP", [9.0, 9.0]); // different bucket — must NOT be picked up

    const raw = (await redis.call(
      "FCALL", "sbm_vega_bucket", "1", "sens:{GIRR:USD}:_", "GIRR", "USD"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };

    // Only 2 rows × 2 tenors with WS=1 each, ρ=0 → K_b = sqrt(4) = 2; S_b = 4
    expect(out.count).toBe(2);
    expect(out.K_b).toBeCloseTo(2.0, 9);
    expect(out.S_b).toBeCloseTo(4.0, 9);
  });

  it.skipIf(!redisAvailable)("returns zero K_b / zero count when the bucket is empty", async () => {
    await loadFrtbLibrary(redis, [buildGirrVegaSnippet({ weight: 1.0, rho: 0.5 })]);
    const raw = (await redis.call(
      "FCALL", "sbm_vega_bucket", "1", "sens:{GIRR:JPY}:_", "GIRR", "JPY"
    )) as string;
    const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
    expect(out.count).toBe(0);
    expect(out.K_b).toBe(0);
    expect(out.S_b).toBe(0);
  });
});
