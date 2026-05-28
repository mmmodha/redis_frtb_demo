// Cross-component regression gate for the `sensitivity_type` enum.
// Hypothesis: `sensitivity_type-case-mismatch` — the generator and the calc
// Lua per-bucket functions must agree on the canonical mixed-case strings
// `"Delta"` / `"Vega"`. If the generator emits any other casing (e.g.
// `"DELTA"` / `"VEGA"`), every Lua FCALL drops every row and count==0,
// which would silently zero out `/calc/sbm`. This test exercises BOTH
// sides in-process and asserts count>0 — that is the gate.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { ulid } from "ulid";

import { loadSchema } from "@frtb/schema";
import { createRowGenerator } from "@frtb/generator/src/row-generator.ts";
import { buildGirrDeltaSnippet } from "../src/girrDeltaSnippet.ts";
import { buildGirrVegaSnippet } from "../src/girrVegaSnippet.ts";
import { loadFrtbLibrary } from "../src/loadFrtbLibrary.ts";

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16412;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const FIXTURE = resolve(HERE, "..", "..", "generator", "tests", "fixtures", "multi-class.yaml");

const GIRR_W = [0.017, 0.017, 0.016, 0.013, 0.012, 0.011, 0.011, 0.011, 0.011, 0.011];
const GIRR_RHO = 0.99;

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-calc-cross-redis-"));
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

// Pick a bucket that has at least one row of the requested sensitivity_type
// from the generator output, and seed those rows into Redis under that
// bucket's hash-tag. Returns the chosen bucket and the seeded row count.
async function seedGirrRowsByType(rows: Array<Record<string, unknown>>, type: string): Promise<{ bucket: string; count: number }> {
  const byBucket = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    if (r.sensitivity_type !== type) continue;
    const b = String(r.bucket);
    const arr = byBucket.get(b) ?? [];
    arr.push(r);
    byBucket.set(b, arr);
  }
  if (byBucket.size === 0) {
    throw new Error(`generator produced no rows with sensitivity_type=${type}`);
  }
  const [bucket, picked] = [...byBucket.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
  for (const r of picked) {
    const key = `sens:{GIRR:${bucket}}:${ulid()}`;
    await redis.set(key, JSON.stringify(r));
  }
  return { bucket, count: picked.length };
}

describe("cross-component sensitivity_type enum (generator ↔ calc Lua)", () => {
  it("generator's SENSITIVITY_TYPES emit the canonical mixed-case strings the Lua filter expects", () => {
    const schema = loadSchema(FIXTURE);
    const gen = createRowGenerator(schema, { seed: "cross-component" });
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(String(gen.generate("GIRR").sensitivity_type));
    // The Lua per-bucket filters compare against exactly these literals.
    expect(seen).toEqual(new Set(["Delta", "Vega"]));
  });

  it.skipIf(!redisAvailable)(
    "rows from the generator are picked up by the GIRR Delta Lua filter (count>0)",
    async () => {
      const schema = loadSchema(FIXTURE);
      const gen = createRowGenerator(schema, { seed: "cross-component-delta" });
      const rows = Array.from({ length: 200 }, () => gen.generate("GIRR"));
      const { bucket, count: seeded } = await seedGirrRowsByType(rows, "Delta");

      await loadFrtbLibrary(redis, [buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO })]);
      const raw = (await redis.call(
        "FCALL", "sbm_delta_bucket", "1", `sens:{GIRR:${bucket}}:_`, "GIRR", bucket
      )) as string;
      const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
      // The whole point of this gate: count must be > 0 when generator-emitted
      // rows are fed into the Lua filter. Pre-fix (uppercase "DELTA"), this is 0.
      expect(out.count).toBe(seeded);
      expect(out.count).toBeGreaterThan(0);
    }
  );

  it.skipIf(!redisAvailable)(
    "rows from the generator are picked up by the GIRR Vega Lua filter (count>0)",
    async () => {
      const schema = loadSchema(FIXTURE);
      const gen = createRowGenerator(schema, { seed: "cross-component-vega" });
      const rows = Array.from({ length: 200 }, () => gen.generate("GIRR"));
      const { bucket, count: seeded } = await seedGirrRowsByType(rows, "Vega");

      await loadFrtbLibrary(redis, [buildGirrVegaSnippet({ weight: 1.0, rho: 0.5 })]);
      const raw = (await redis.call(
        "FCALL", "sbm_vega_bucket", "1", `sens:{GIRR:${bucket}}:_`, "GIRR", bucket
      )) as string;
      const out = JSON.parse(raw) as { K_b: number; S_b: number; count: number };
      expect(out.count).toBe(seeded);
      expect(out.count).toBeGreaterThan(0);
    }
  );
});
