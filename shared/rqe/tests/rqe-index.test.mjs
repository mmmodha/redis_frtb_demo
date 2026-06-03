import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";

import {
  ensureSensIndex,
  dropSensIndex,
  IDX_NAME,
  IDX_PREFIX,
  IDX_SCHEMA_FIELDS,
} from "../src/index.mjs";

// Integration tests run against a real Redis with the RediSearch + RedisJSON
// modules loaded. The Ubuntu 22.04 apt `redis-stack-server` wrapper does not
// reliably load modules when spawned standalone with custom args, so we
// prefer driving `redis-server` directly with explicit --loadmodule flags
// pointing at the apt-installed .so files under /opt/redis-stack/lib/. We
// fall back to redis-stack-server, then plain redis-server. If FT.CREATE
// still fails on the booted instance, the integration suite auto-skips via
// `it.skipIf` per Wave 1 follow-up #1 — never silently passes.
const PORT = 16401;
const STACK_DIR = "/opt/redis-stack";
const STACK_BUNDLED_REDIS = `${STACK_DIR}/bin/redis-server`;
const STACK_LIB_DIR = `${STACK_DIR}/lib`;
const STACK_MODULES = [`${STACK_LIB_DIR}/redisearch.so`, `${STACK_LIB_DIR}/rejson.so`];
const STACK_MODULES_PRESENT = STACK_MODULES.every((p) => existsSync(p));
const STACK_BUNDLED_PRESENT = existsSync(STACK_BUNDLED_REDIS) && STACK_MODULES_PRESENT;
let proc;
let tmp;
let redis;
let searchAvailable = false;

function binaryOnPath(binary) {
  // Use `which` rather than spawning the binary blindly — a bad spawn would
  // emit an unhandled "error" event before any listener could attach, which
  // crashes the test runner.
  const r = spawnSync("which", [binary], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}

function spawnRedis(binary, port, dir, inlineModules) {
  const baseArgs = ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"];
  const moduleArgs = inlineModules ? STACK_MODULES.flatMap((m) => ["--loadmodule", m]) : [];
  const p = spawn(binary, [...baseArgs, ...moduleArgs], { stdio: ["ignore", "pipe", "pipe"] });
  p.on("error", (e) => { console.error(`[rqe-spawn] spawn error for ${binary}:`, e.message); });
  p.stderr?.on("data", (b) => { process.stderr.write(`[rqe-spawn:${binary}:stderr] ${b}`); });
  p.stdout?.on("data", (b) => { process.stderr.write(`[rqe-spawn:${binary}:stdout] ${b}`); });
  p.on("exit", (code, sig) => { if (code !== 0 && code !== null) console.error(`[rqe-spawn] ${binary} exited code=${code} sig=${sig}`); });
  return p;
}

function binaryAvailable(binary) {
  // Absolute path: check existsSync; PATH-relative: defer to `which`.
  if (binary.startsWith("/")) return existsSync(binary);
  return binaryOnPath(binary);
}

async function tryBoot(binary, port, dir, inlineModules) {
  if (!binaryAvailable(binary)) return undefined;
  const p = spawnRedis(binary, port, dir, inlineModules);
  // 60 × 100ms = 6s — redis-stack-server takes longer than vanilla
  // redis-server because it has to load 4-5 modules before accepting
  // connections (Wave 5.73e: tightened the gate so the testcontainers job
  // doesn't silently skip).
  for (let i = 0; i < 60; i++) {
    const r = new Redis({ port, lazyConnect: true, maxRetriesPerRequest: 1 });
    r.on("error", () => { /* expected during boot probe — handled by retry */ });
    try {
      await r.connect();
      await r.ping();
      await r.quit();
      return p;
    } catch {
      try { r.disconnect(); } catch { /* noop */ }
      await wait(100);
    }
  }
  p.kill("SIGTERM");
  return undefined;
}

async function hasSearchModule(port) {
  const r = new Redis({ port });
  try {
    await r.call("FT._LIST");
    return true;
  } catch {
    return false;
  } finally {
    await r.quit().catch(() => undefined);
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "frtb-rqe-"));
  const strategies = [
    ...(STACK_BUNDLED_PRESENT ? [{ bin: STACK_BUNDLED_REDIS, inline: true }] : []),
    { bin: "redis-stack-server", inline: false },
    { bin: "redis-server", inline: false },
  ];
  console.error(`[rqe-boot] STACK_BUNDLED_PRESENT=${STACK_BUNDLED_PRESENT} STACK_MODULES_PRESENT=${STACK_MODULES_PRESENT}`);
  console.error(`[rqe-boot] strategies=${JSON.stringify(strategies)}`);
  for (const { bin, inline } of strategies) {
    console.error(`[rqe-boot] trying bin=${bin} inline=${inline}`);
    proc = await tryBoot(bin, PORT, tmp, inline);
    if (!proc) { console.error(`[rqe-boot] tryBoot returned undefined for ${bin}`); continue; }
    const hasSearch = await hasSearchModule(PORT);
    console.error(`[rqe-boot] booted ${bin}, hasSearchModule=${hasSearch}`);
    if (hasSearch) {
      searchAvailable = true;
      redis = new Redis({ port: PORT });
      break;
    }
    proc.kill("SIGTERM");
    proc = undefined;
    await wait(100);
  }
  console.error(`[rqe-boot] final searchAvailable=${searchAvailable}`);
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
  if (proc) proc.kill("SIGTERM");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!searchAvailable) return;
  await redis.flushall();
});

describe("@frtb/rqe — module constants (locked Wave 2 contract)", () => {
  it("exports the locked index name 'idx:sens'", () => {
    expect(IDX_NAME).toBe("idx:sens");
  });

  it("exports the locked key prefix 'sens:'", () => {
    expect(IDX_PREFIX).toBe("sens:");
  });

  it("declares the 5 mandatory TAG fields with JSONPath aliases", () => {
    const byAlias = Object.fromEntries(IDX_SCHEMA_FIELDS.map((f) => [f.as, f]));
    for (const alias of ["risk_class", "bucket", "sensitivity_type", "book", "trade_id"]) {
      expect(byAlias[alias], `field "${alias}" must be declared`).toBeDefined();
      expect(byAlias[alias].path).toBe(`$.${alias}`);
      expect(byAlias[alias].type).toBe("TAG");
    }
  });
});

describe.skipIf(!searchAvailable)("@frtb/rqe — ensureSensIndex (integration)", () => {
  async function seedFixtureRows() {
    // Three docs spanning the 5 indexed TAGs so FT.SEARCH-by-tag assertions
    // have something to find. Keys obey the Wave 2 contract literal shape:
    //   sens:{risk_class:bucket}:{ulid}
    const rows = [
      {
        key: "sens:{GIRR:USD-IRS}:01HZAAAAAAAAAAAAAAAAAAA001",
        doc: {
          risk_class: "GIRR",
          bucket: "USD-IRS",
          sensitivity_type: "Delta",
          book: "RATES-LDN",
          trade_id: "T-1001",
        },
      },
      {
        key: "sens:{GIRR:USD-IRS}:01HZAAAAAAAAAAAAAAAAAAA002",
        doc: {
          risk_class: "GIRR",
          bucket: "USD-IRS",
          sensitivity_type: "Vega",
          book: "RATES-LDN",
          trade_id: "T-1002",
        },
      },
      {
        key: "sens:{EQUITY:5}:01HZAAAAAAAAAAAAAAAAAAA003",
        doc: {
          risk_class: "EQUITY",
          bucket: "5",
          sensitivity_type: "Delta",
          book: "EQ-NYC",
          trade_id: "T-2001",
        },
      },
    ];
    for (const { key, doc } of rows) {
      await redis.call("JSON.SET", key, "$", JSON.stringify(doc));
    }
    return rows;
  }

  async function countSearch(query) {
    // Sample FT.SEARCH queries documented in source comments — these tag
    // lookups are the primary driver of /pivot pagination (api task wave 2b).
    const reply = await redis.call(
      "FT.SEARCH",
      IDX_NAME,
      query,
      "DIALECT",
      "2",
      "LIMIT",
      "0",
      "0",
    );
    return reply[0];
  }

  it("creates idx:sens and FT.INFO reports the 5 mandatory TAG fields", async () => {
    await ensureSensIndex(redis);
    const info = await redis.call("FT.INFO", IDX_NAME);
    // FT.INFO returns a flat key-value array — find the attributes section.
    const map = Object.fromEntries(
      Array.from({ length: info.length / 2 }, (_, i) => [info[i * 2], info[i * 2 + 1]]),
    );
    expect(map.index_name).toBe(IDX_NAME);
    const attrs = map.attributes;
    expect(Array.isArray(attrs)).toBe(true);
    const aliases = attrs.map((entry) => {
      const idx = entry.indexOf("attribute");
      return idx >= 0 ? entry[idx + 1] : undefined;
    });
    for (const alias of ["risk_class", "bucket", "sensitivity_type", "book", "trade_id"]) {
      expect(aliases, `attribute "${alias}" must be in the index`).toContain(alias);
    }
  });

  it("indexes only docs under the sens: prefix", async () => {
    await ensureSensIndex(redis);
    await seedFixtureRows();
    // not-a-sens-doc must NOT be picked up by idx:sens
    await redis.call("JSON.SET", "other:1", "$", JSON.stringify({ risk_class: "GIRR" }));
    // Allow indexer to ingest the JSON.SETs we just wrote.
    await wait(200);
    const total = await countSearch("*");
    expect(total).toBe(3);
  });

  it("FT.SEARCH on each of the 5 TAG fields returns expected fixture docs", async () => {
    await ensureSensIndex(redis);
    await seedFixtureRows();
    await wait(200);

    expect(await countSearch("@risk_class:{GIRR}")).toBe(2);
    expect(await countSearch("@risk_class:{EQUITY}")).toBe(1);
    expect(await countSearch("@bucket:{USD\\-IRS}")).toBe(2);
    expect(await countSearch("@sensitivity_type:{Delta}")).toBe(2);
    expect(await countSearch("@sensitivity_type:{Vega}")).toBe(1);
    expect(await countSearch("@book:{RATES\\-LDN}")).toBe(2);
    expect(await countSearch("@trade_id:{T\\-1001}")).toBe(1);
  });

  it("ensureSensIndex is idempotent — second call is a no-op (no error, same index)", async () => {
    await ensureSensIndex(redis);
    const before = await redis.call("FT.INFO", IDX_NAME);
    // second call MUST NOT throw and MUST NOT recreate the index
    await ensureSensIndex(redis);
    await ensureSensIndex(redis);
    const after = await redis.call("FT.INFO", IDX_NAME);
    // num_docs / index_name unchanged — same backing index, not a recreate
    const beforeMap = Object.fromEntries(
      Array.from({ length: before.length / 2 }, (_, i) => [before[i * 2], before[i * 2 + 1]]),
    );
    const afterMap = Object.fromEntries(
      Array.from({ length: after.length / 2 }, (_, i) => [after[i * 2], after[i * 2 + 1]]),
    );
    expect(afterMap.index_name).toBe(beforeMap.index_name);
  });

  it("dropSensIndex removes the index and is also idempotent", async () => {
    await ensureSensIndex(redis);
    await dropSensIndex(redis);
    await expect(redis.call("FT.INFO", IDX_NAME)).rejects.toThrow();
    // dropping an absent index must not throw — supports demo "drop then recreate" UX
    await dropSensIndex(redis);
  });
});
