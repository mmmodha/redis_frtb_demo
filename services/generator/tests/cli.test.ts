import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const PORT = 16400;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;

// `it.skipIf` evaluates at test-registration time — detect redis-server on
// PATH synchronously at module load so the skip decision is made up-front.
function hasOnPath(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const redisAvailable = hasOnPath("redis-server");

beforeAll(async () => {
  if (!redisAvailable) return;
  tmp = mkdtempSync(join(tmpdir(), "frtb-gen-cli-"));
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
  if (redisAvailable) await redis.flushall();
});

describe("generator CLI", () => {
  it.skipIf(!redisAvailable)("produces --rows N rows to the Stream when --classes is restricted to one class", () => {
    const res = spawnSync(
      process.execPath,
      [tsx, cli, "--rows", "500", "--classes", "fx", "--seed", "1", "--batch-size", "100"],
      {
        env: {
          ...process.env,
          SCHEMA_FILE: multiClass,
          REDIS_URL: `redis://127.0.0.1:${PORT}`,
          REDIS_CLUSTER: "false",
          STREAM_KEY: "sensitivities:in",
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    expect((res.stdout + res.stderr).toLowerCase()).toMatch(/done|finished|rows\/sec/);
  });

  it.skipIf(!redisAvailable)("respects --classes all and produces rows across every schema-defined class", async () => {
    const res = spawnSync(
      process.execPath,
      [tsx, cli, "--rows", "300", "--classes", "all", "--seed", "2"],
      {
        env: {
          ...process.env,
          SCHEMA_FILE: multiClass,
          REDIS_URL: `redis://127.0.0.1:${PORT}`,
          REDIS_CLUSTER: "false",
          STREAM_KEY: "sensitivities:in",
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const len = await redis.xlen("sensitivities:in");
    expect(len).toBe(300);
    // Confirm we see a representative spread of risk_class field values
    const items = await redis.xrange("sensitivities:in", "-", "+", "COUNT", 300);
    const classes = new Set<string>();
    for (const [, fields] of items) {
      const map = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]])
      );
      classes.add(map.risk_class as string);
    }
    expect(classes).toEqual(new Set(["GIRR", "EQUITY", "FX"]));
  });

  it.skipIf(!redisAvailable)("each Stream entry carries _hash_tag = '{risk_class}:{bucket}'", async () => {
    spawnSync(
      process.execPath,
      [tsx, cli, "--rows", "50", "--classes", "girr", "--seed", "3"],
      {
        env: {
          ...process.env,
          SCHEMA_FILE: multiClass,
          REDIS_URL: `redis://127.0.0.1:${PORT}`,
          REDIS_CLUSTER: "false",
          STREAM_KEY: "sensitivities:in",
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    const items = await redis.xrange("sensitivities:in", "-", "+", "COUNT", 50);
    expect(items.length).toBe(50);
    for (const [, fields] of items) {
      const map = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]])
      );
      expect(map._hash_tag).toBe(`${map.risk_class}:${map.bucket}`);
    }
  });

  // Wave 5.14b.2: pins the literal argv shape that the smoke-run-6 author
  // tried to pass through `docker compose run --rm generator --rows 10000
  // --classes girr,equity` and that the Dockerfile CMD-vs-ENTRYPOINT fix
  // unblocks. Validates argv reaches the script (commander parses --rows and
  // --classes), not the docker layer.
  it.skipIf(!redisAvailable)("argv --rows 10000 --classes girr,equity reaches the script and produces rows only across those classes", async () => {
    const res = spawnSync(
      process.execPath,
      [tsx, cli, "--rows", "10000", "--classes", "girr,equity", "--seed", "5", "--batch-size", "1000"],
      {
        env: {
          ...process.env,
          SCHEMA_FILE: multiClass,
          REDIS_URL: `redis://127.0.0.1:${PORT}`,
          REDIS_CLUSTER: "false",
          STREAM_KEY: "sensitivities:in",
        },
        encoding: "utf8",
        timeout: 60_000,
      }
    );
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    const len = await redis.xlen("sensitivities:in");
    expect(len).toBe(10000);
    const items = await redis.xrange("sensitivities:in", "-", "+", "COUNT", 10000);
    const classes = new Set<string>();
    for (const [, fields] of items) {
      const map = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]])
      );
      classes.add(map.risk_class as string);
    }
    expect(classes).toEqual(new Set(["GIRR", "EQUITY"]));
  });

  // Wave 5.84C — --profile auto against the localhost standalone redis-server
  // picks the `small` profile; --dry-run exits 0 without writing any rows
  // and emits the plan block on stderr (pino default sink). DoD #1.
  it.skipIf(!redisAvailable)("--profile auto + --dry-run against standalone redis → picks small, exit 0, no rows written", async () => {
    const res = spawnSync(
      process.execPath,
      [tsx, cli, "--rows", "1000000", "--profile", "auto", "--dry-run"],
      {
        env: {
          ...process.env,
          SCHEMA_FILE: multiClass,
          REDIS_URL: `redis://127.0.0.1:${PORT}`,
          REDIS_CLUSTER: "false",
          STREAM_KEY: "sensitivities:in",
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toMatch(/plan/);
    expect(combined).toMatch(/profile=small/);
    expect(combined).toMatch(/dry-run/);
    // No rows produced — the dry-run path exits before opening the producer.
    const len = await redis.xlen("sensitivities:in");
    expect(len).toBe(0);
  });

  // Wave 5.84C — explicit --profile small forces the small dials regardless
  // of detected shape (DoD #3). Manual --batch-size overrides the profile's
  // dial value (manual always wins — DoD #4).
  it.skipIf(!redisAvailable)("explicit --profile small + manual --batch-size 250 overrides profile dial (DoD #3 + #4)", async () => {
    const res = spawnSync(
      process.execPath,
      [tsx, cli, "--rows", "100", "--profile", "small", "--batch-size", "250", "--dry-run"],
      {
        env: { ...process.env, SCHEMA_FILE: multiClass, REDIS_URL: `redis://127.0.0.1:${PORT}`, REDIS_CLUSTER: "false", STREAM_KEY: "sensitivities:in" },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toMatch(/profile=small/);
    expect(combined).toMatch(/batch:250/);
  });

  // Wave 5.84C — refuse-or-go gate. Cap maxmemory at 4 MB on the test redis
  // and request 100k rows × 2 KB ≈ 200 MB → > 50% of 4 MB → exits non-zero
  // unless --force is passed (DoD #5).
  it.skipIf(!redisAvailable)("refuse-or-go: rows*2KB > 50% of maxmemory exits non-zero; --force proceeds", async () => {
    // CONFIG SET maxmemory 4mb at runtime so the gate trips.
    await redis.config("SET", "maxmemory", "4mb");
    try {
      const env = { ...process.env, SCHEMA_FILE: multiClass, REDIS_URL: `redis://127.0.0.1:${PORT}`, REDIS_CLUSTER: "false", STREAM_KEY: "sensitivities:in" } as NodeJS.ProcessEnv;
      // No --force → must exit non-zero with a refuse message.
      const r1 = spawnSync(
        process.execPath,
        [tsx, cli, "--rows", "100000", "--profile", "auto", "--dry-run"],
        { env, encoding: "utf8", timeout: 30_000 },
      );
      expect(r1.status, `r1 stdout:\n${r1.stdout}\nstderr:\n${r1.stderr}`).not.toBe(0);
      expect((r1.stdout + r1.stderr)).toMatch(/refusing|--force/);

      // With --force the run is allowed; --dry-run still skips the actual
      // write so we only need to assert exit 0.
      const r2 = spawnSync(
        process.execPath,
        [tsx, cli, "--rows", "100000", "--profile", "auto", "--dry-run", "--force"],
        { env, encoding: "utf8", timeout: 30_000 },
      );
      expect(r2.status, `r2 stdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`).toBe(0);
    } finally {
      await redis.config("SET", "maxmemory", "0");
    }
  });

  it.skipIf(!redisAvailable)("re-running with a different SCHEMA_FILE produces rows in the new shape (proves schema swap)", async () => {
    const swap = resolve(here, "fixtures/swap-schema.yaml");
    spawnSync(
      process.execPath,
      [tsx, cli, "--rows", "20", "--classes", "fx", "--seed", "4"],
      {
        env: { ...process.env, SCHEMA_FILE: swap, REDIS_URL: `redis://127.0.0.1:${PORT}`, REDIS_CLUSTER: "false", STREAM_KEY: "sensitivities:in" },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    const items = await redis.xrange("sensitivities:in", "-", "+", "COUNT", 20);
    expect(items.length).toBe(20);
    for (const [, fields] of items) {
      const map = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]])
      );
      const payload = JSON.parse(map.payload as string);
      expect(payload).toHaveProperty("spread");           // new schema field
      // Wave 5.17a — swap-schema NUMERIC risk_value is now `{ spot }`.
      expect(typeof payload.risk_value).toBe("object");
      expect(typeof payload.risk_value.spot).toBe("number");
    }
  });
});
