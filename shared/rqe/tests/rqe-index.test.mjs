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
  buildCreateArgs,
  buildSchemaFields,
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
// IMPORTANT: vitest evaluates `describe.skipIf(!searchAvailable)` at file
// collection time, BEFORE `beforeAll` runs. So we seed the flag from the
// synchronous on-disk module check; beforeAll then performs the actual boot
// and downgrades the flag to false if the boot fails (Wave 5.73e).
let searchAvailable = STACK_BUNDLED_PRESENT;

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
  const p = spawn(binary, [...baseArgs, ...moduleArgs], { stdio: "ignore" });
  p.on("error", () => { /* swallow — tryBoot returns undefined on connection timeout */ });
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
  let booted = false;
  for (const { bin, inline } of strategies) {
    proc = await tryBoot(bin, PORT, tmp, inline);
    if (!proc) continue;
    if (await hasSearchModule(PORT)) {
      redis = new Redis({ port: PORT });
      booted = true;
      break;
    }
    proc.kill("SIGTERM");
    proc = undefined;
    await wait(100);
  }
  // Downgrade the collection-time optimistic flag if the actual boot failed.
  searchAvailable = booted;
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

  // Wave 5.83A — trader (per-row attribution) and _calibration
  // (low-cardinality ingest tag) are part of the static base now.
  it("declares trader and _calibration as static TAGs", () => {
    const byAlias = Object.fromEntries(IDX_SCHEMA_FIELDS.map((f) => [f.as, f]));
    expect(byAlias.trader).toEqual({ path: "$.trader", as: "trader", type: "TAG" });
    expect(byAlias._calibration).toEqual({ path: "$._calibration", as: "_calibration", type: "TAG" });
  });
});

// Wave 5.83A — buildSchemaFields drives the per-class per-tenor pre-weighted
// NUMERIC SORTABLE field set off the schema (GIRR per-tenor; Equity/FX
// scalar). These tests pin the shape so the FT.CREATE argv the api boot
// emits stays a deterministic function of the schema.
describe("@frtb/rqe — buildSchemaFields / buildCreateArgs (Wave 5.83A)", () => {
  const tenors = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"];
  const fakeSchema = {
    risk_classes: {
      GIRR: { tenor: { nodes: tenors } },
      EQUITY: {},
      FX: {},
    },
  };

  it("returns the static base unchanged when called with no schema", () => {
    const fields = buildSchemaFields();
    expect(fields).toEqual([...IDX_SCHEMA_FIELDS]);
  });

  it("emits ws_girr_<leg>_<tenor> NUMERIC SORTABLE for every (leg × tenor) on GIRR", () => {
    const fields = buildSchemaFields(fakeSchema);
    const byAlias = Object.fromEntries(fields.map((f) => [f.as, f]));
    for (const leg of ["delta", "vega", "cvr_up", "cvr_down"]) {
      for (const t of tenors) {
        const alias = `ws_girr_${leg}_${t}`;
        expect(byAlias[alias], `${alias} must be declared`).toBeDefined();
        expect(byAlias[alias].type).toBe("NUMERIC");
        expect(byAlias[alias].sortable).toBe(true);
      }
    }
    // Wave 5.83F — per-tenor maps now live at the `*_per_tenor` JSONPaths so
    // the bare $.weighted_value / $.weighted_cvr_* paths can stay scalar
    // (NUMERIC) across every risk class without colliding with the GIRR
    // Object value (which used to abort idx:sens indexing).
    expect(byAlias.ws_girr_delta_3M.path).toBe('$.weighted_value_per_tenor["3M"]');
    expect(byAlias.ws_girr_vega_10Y.path).toBe('$.weighted_value_per_tenor["10Y"]');
    expect(byAlias.ws_girr_cvr_up_2Y.path).toBe('$.weighted_cvr_up_per_tenor["2Y"]');
    expect(byAlias.ws_girr_cvr_down_30Y.path).toBe('$.weighted_cvr_down_per_tenor["30Y"]');
  });

  it("emits scalar ws_<class>_<leg> NUMERIC SORTABLE for Equity/FX (no tenor suffix)", () => {
    const fields = buildSchemaFields(fakeSchema);
    const byAlias = Object.fromEntries(fields.map((f) => [f.as, f]));
    for (const klass of ["equity", "fx"]) {
      for (const [leg, path] of [
        ["delta", "$.weighted_value"],
        ["vega", "$.weighted_value"],
        ["cvr_up", "$.weighted_cvr_up"],
        ["cvr_down", "$.weighted_cvr_down"],
      ]) {
        const alias = `ws_${klass}_${leg}`;
        expect(byAlias[alias], `${alias} must be declared`).toBeDefined();
        expect(byAlias[alias].path).toBe(path);
        expect(byAlias[alias].type).toBe("NUMERIC");
        expect(byAlias[alias].sortable).toBe(true);
        // No tenor-suffixed variant for scalar classes.
        expect(byAlias[`${alias}_3M`]).toBeUndefined();
      }
    }
  });

  it("buildCreateArgs(schema) appends SORTABLE for every dynamic NUMERIC field", () => {
    const args = buildCreateArgs(fakeSchema);
    // The static head is unchanged shape — ON JSON PREFIX 1 sens: SCHEMA …
    expect(args.slice(0, 7)).toEqual([IDX_NAME, "ON", "JSON", "PREFIX", "1", IDX_PREFIX, "SCHEMA"]);
    // Every "NUMERIC" token in the argv is immediately followed by "SORTABLE".
    let numericCount = 0;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "NUMERIC") {
        numericCount += 1;
        expect(args[i + 1], `NUMERIC at arg ${i} must be followed by SORTABLE`).toBe("SORTABLE");
      }
    }
    // 4 legs × (10 GIRR tenors + 1 Equity scalar + 1 FX scalar) = 48 dynamic
    // NUMERIC fields. Pin the count so a leg/tenor change is loud.
    expect(numericCount).toBe(48);
  });
});

// Wave 5.73f: gate on the synchronous on-disk module check directly so
// vitest sees the right value at collection time (describe.skipIf is
// evaluated eagerly, before beforeAll). STACK_BUNDLED_PRESENT is the
// boot-success precondition in CI.
describe.skipIf(!STACK_BUNDLED_PRESENT)("@frtb/rqe — ensureSensIndex (integration)", () => {
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
