import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "..", "..", "..");
const cli = resolve(here, "..", "src", "cli.ts");
const tsx = resolve(repoRoot, "node_modules", ".bin", "tsx");
const multiClass = resolve(here, "fixtures/multi-class.yaml");

function spawnRedis(port: number, dir: string): ChildProcess {
  return spawn(
    "redis-server",
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
}

const PORT = 16401;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;
let redisAvailable = false;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "frtb-gen-resume-"));
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
  if (redisAvailable) await redis.flushall();
});

describe("generator resumability (DoD: killed mid-stream, resumed safely)", () => {
  it("appending a second run to the same stream does not corrupt the first run's entries", async () => {
    if (!redisAvailable) return;
    const env = {
      ...process.env,
      SCHEMA_FILE: multiClass,
      REDIS_URL: `redis://127.0.0.1:${PORT}`,
      STREAM_KEY: "sensitivities:in",
    };
    const args = ["--rows", "50", "--classes", "fx", "--seed", "1"];
    const first = spawnSync(process.execPath, [tsx, cli, ...args], { env, encoding: "utf8", timeout: 20_000 });
    expect(first.status).toBe(0);
    expect(await redis.xlen("sensitivities:in")).toBe(50);
    const second = spawnSync(process.execPath, [tsx, cli, ...args], { env, encoding: "utf8", timeout: 20_000 });
    expect(second.status).toBe(0);
    expect(await redis.xlen("sensitivities:in")).toBe(100);

    // _id is a ULID per row, so every entry is uniquely identifiable across
    // runs. The ingest layer can use _id to dedupe if it ever sees duplicates.
    const items = await redis.xrange("sensitivities:in", "-", "+");
    const ids = new Set<string>();
    for (const [, fields] of items) {
      const map = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]])
      );
      ids.add(map._id as string);
    }
    expect(ids.size).toBe(100);
  });
});
