import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
// modules loaded. We try `redis-stack-server` first (the documented Wave 2
// runtime), then fall back to `redis-server` (which has search bundled in
// Redis 8). If FT.CREATE fails on the booted instance, the integration suite
// auto-skips via `it.skipIf` per Wave 1 follow-up #1 — never silently passes.
const PORT = 16401;
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

function spawnRedis(binary, port, dir) {
  const p = spawn(
    binary,
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" }
  );
  p.on("error", () => { /* swallow — tryBoot returns undefined on connection timeout */ });
  return p;
}

async function tryBoot(binary, port, dir) {
  if (!binaryOnPath(binary)) return undefined;
  const p = spawnRedis(binary, port, dir);
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
  for (const bin of ["redis-stack-server", "redis-server"]) {
    proc = await tryBoot(bin, PORT, tmp);
    if (!proc) continue;
    if (await hasSearchModule(PORT)) {
      searchAvailable = true;
      redis = new Redis({ port: PORT });
      break;
    }
    proc.kill("SIGTERM");
    proc = undefined;
    await wait(100);
  }
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
