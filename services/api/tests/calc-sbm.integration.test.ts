import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { createServer } from "../src/server.ts";

// Integration test for the MVP endpoint POST /calc/sbm against a real
// redis-stack-server. Loads a tiny stub `frtb` Function library that returns
// canned per-bucket {K_b, S_b, count, ms} so we can validate the api's
// orchestration end-to-end (discover via FT.AGGREGATE → fanout FCALL → reduce).
//
// Skipped automatically when redis-stack-server is not on PATH (the actual
// FRTB function bodies are owned by the calc agents).

const PORT = 16401;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis | undefined;
let stackAvailable = false;

function spawnRedisStack(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-stack-server",
    [
      "--port",
      String(port),
      "--dir",
      dir,
      "--save",
      "",
      "--appendonly",
      "no",
      "--protected-mode",
      "no",
    ],
    { stdio: "ignore" }
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "frtb-api-stack-"));
  try {
    proc = spawnRedisStack(PORT, tmp);
  } catch {
    return;
  }
  proc?.on("error", () => undefined);
  for (let i = 0; i < 40; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      const modules = (await r.call("MODULE", "LIST")) as unknown[][];
      const names = modules.map((m) => String(m[1]));
      if (names.includes("search") && names.includes("ReJSON")) {
        stackAvailable = true;
      }
      await r.quit();
      break;
    } catch {
      await wait(150);
    }
  }
  if (!stackAvailable) return;
  redis = new Redis({ port: PORT });

  // Load tiny stub frtb library so the api can FCALL frtb.sbm_delta_bucket.
  // Real bodies are owned by the calc agents (tasks 6cfa59a6, 372f4af6).
  const stubLib = `#!lua name=frtb
redis.register_function('sbm_delta_bucket', function(keys, args)
  return {'K_b','3','S_b','3','count','5','ms','1'}
end)
redis.register_function('sbm_vega_bucket', function(keys, args)
  return {'K_b','4','S_b','4','count','7','ms','1'}
end)
`;
  await redis.call("FUNCTION", "LOAD", "REPLACE", stubLib);

  // Tiny fixture: 4 GIRR docs across 2 buckets so FT.AGGREGATE returns 2 buckets.
  await redis.call(
    "FT.CREATE",
    "idx:sens",
    "ON",
    "JSON",
    "PREFIX",
    "1",
    "sens:",
    "SCHEMA",
    "$.risk_class",
    "AS",
    "risk_class",
    "TAG",
    "$.bucket",
    "AS",
    "bucket",
    "TAG"
  );
  const docs = [
    { key: "sens:{GIRR:USD-IRS}:01a", body: { risk_class: "GIRR", bucket: "USD-IRS" } },
    { key: "sens:{GIRR:USD-IRS}:01b", body: { risk_class: "GIRR", bucket: "USD-IRS" } },
    { key: "sens:{GIRR:EUR-IRS}:01c", body: { risk_class: "GIRR", bucket: "EUR-IRS" } },
    { key: "sens:{GIRR:EUR-IRS}:01d", body: { risk_class: "GIRR", bucket: "EUR-IRS" } },
  ];
  for (const d of docs) {
    await redis.call("JSON.SET", d.key, "$", JSON.stringify(d.body));
  }
}, 30_000);

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
  if (proc) proc.kill("SIGTERM");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("POST /calc/sbm — integration against redis-stack-server", () => {
  it.skipIf(!stackAvailable)(
    "discovers buckets, FCALLs the stub frtb library, reduces — under 2s wall-clock",
    async () => {
      const app = await createServer({
        redis: redis!,
        correlations: { GIRR: { kind: "constant", value: 0 } },
      });
      try {
        const t0 = Date.now();
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
        });
        const wall = Date.now() - t0;
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // ΣK² = 9+9 = 18 → sqrt(18) ≈ 4.2426
        expect(body.charge).toBeCloseTo(Math.sqrt(18), 6);
        expect(body.per_bucket).toHaveLength(2);
        expect(wall).toBeLessThan(2000);
      } finally {
        await app.close();
      }
    }
  );
});
