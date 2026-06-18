import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Redis } from "ioredis";
import { monotonicFactory } from "ulid";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildKey,
  buildDoc,
  enrichDoc,
  emitRollupHincrs,
  emitSeenSadds,
  CALIBRATION_TAG,
  ensureGroup,
  processBatch,
  createConsumer,
} from "../src/consumer.ts";
import { backfill } from "../src/backfill-weighted.ts";
import { backfillRollups, accumulateRollup } from "../src/backfill-rollups.ts";
import { loadSchema, type Schema } from "@frtb/schema";
import {
  rollupKey,
  SEEN_RISK_CLASS_KEY,
  seenBucketKey,
  seenSensTypeKey,
} from "@frtb/calc-shared";

// Wave 5.83B — schema loaded from the locked default YAML so the
// enrichDoc tests assert against the committed risk_weights values
// (girr_delta_weights, equity_weights, fx_weights).
const here = resolve(fileURLToPath(import.meta.url), "..");
const SCHEMA_PATH = resolve(here, "../../../config/schema/frtb-default.yaml");
const SCHEMA: Schema = loadSchema(SCHEMA_PATH);
const GIRR_W = SCHEMA.risk_weights.girr_delta_weights as { by_tenor: Record<string, number> };
const EQUITY_W = SCHEMA.risk_weights.equity_weights as { by_bucket: Record<string, number> };
const FX_W = SCHEMA.risk_weights.fx_weights as { constant: number };
const TOL = 1e-12;

// Wave 5.73e — prefer driving redis-server with explicit --loadmodule pointing
// at the apt-installed redis-stack .so files (the apt redis-stack-server
// wrapper does not reliably load modules when spawned standalone with custom
// args). Falls back to redis-stack-server, then vanilla redis-server. Ubuntu
// 22.04 apt redis-server is 6.0 and lacks JSON.* commands, so jsonAvailable
// would always be false without picking up the stack modules.
function binaryOnPath(binary: string): boolean {
  const r = spawnSync("which", [binary], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}
const STACK_DIR = "/opt/redis-stack";
const STACK_BUNDLED_REDIS = `${STACK_DIR}/bin/redis-server`;
const STACK_LIB_DIR = `${STACK_DIR}/lib`;
const STACK_MODULES = [`${STACK_LIB_DIR}/redisearch.so`, `${STACK_LIB_DIR}/rejson.so`];
const STACK_MODULES_PRESENT = STACK_MODULES.every((p) => existsSync(p));
const STACK_BUNDLED_PRESENT = existsSync(STACK_BUNDLED_REDIS) && STACK_MODULES_PRESENT;
// Prefer the Redis 7.4 binary bundled with the apt redis-stack-server pkg —
// /usr/bin/redis-server is Redis 6.0 on Ubuntu 22.04 and crashes when trying
// to load Redis-7 modules.
const REDIS_BIN = process.env.REDIS_STACK_BIN && binaryOnPath(process.env.REDIS_STACK_BIN)
  ? process.env.REDIS_STACK_BIN
  : (STACK_BUNDLED_PRESENT
    ? STACK_BUNDLED_REDIS
    : (binaryOnPath("redis-stack-server") ? "redis-stack-server" : "redis-server"));
const USE_INLINE_MODULES = REDIS_BIN === STACK_BUNDLED_REDIS;

function spawnRedis(port: number, dir: string): ChildProcess {
  const baseArgs = ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"];
  const moduleArgs = USE_INLINE_MODULES ? STACK_MODULES.flatMap((m) => ["--loadmodule", m]) : [];
  const p = spawn(REDIS_BIN, [...baseArgs, ...moduleArgs], { stdio: "ignore" });
  p.on("error", () => undefined);
  return p;
}

const PORT = 16410;
let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis;
// IMPORTANT: vitest evaluates `it.skipIf(!redisAvailable || !jsonAvailable)`
// at file collection time, BEFORE `beforeAll` runs. Seed these flags from
// the synchronous on-disk module check so the integration tests are
// included; beforeAll then performs the actual boot and downgrades them to
// false if the boot fails (Wave 5.73e).
let redisAvailable = STACK_BUNDLED_PRESENT;
let jsonAvailable = STACK_BUNDLED_PRESENT;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "frtb-ingest-redis-"));
  proc = spawnRedis(PORT, tmp);
  // 60 × 100ms = 6s — redis-stack-server with modules loads slower than vanilla
  // redis-server (Wave 5.73e).
  let booted = false;
  let json = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = new Redis({ port: PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      await r.ping();
      try {
        await r.call("JSON.SET", "__probe__", "$", '{"ok":1}');
        await r.del("__probe__");
        json = true;
      } catch { json = false; }
      await r.quit();
      booted = true;
      break;
    } catch {
      await wait(100);
    }
  }
  // Downgrade the collection-time optimistic flags if the actual boot failed.
  redisAvailable = booted;
  jsonAvailable = json;
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

const ulid = monotonicFactory();

function makeRow(riskClass: string, bucket: string, rest: Record<string, unknown>) {
  const id = ulid();
  return {
    risk_class: riskClass,
    bucket,
    _hash_tag: `${riskClass}:${bucket}`,
    _id: id,
    payload: JSON.stringify(rest),
  };
}

async function xaddRow(stream: string, row: ReturnType<typeof makeRow>): Promise<string> {
  const args: string[] = [];
  for (const [k, v] of Object.entries(row)) { args.push(k, String(v)); }
  return (await redis.xadd(stream, "*", ...args)) as string;
}

describe("consumer pure helpers", () => {
  it("buildKey returns the brace-less sens:{ulid} shape", () => {
    const k = buildKey("GIRR:USD-IRS", "01HZABCDEF1234567890123456");
    expect(k).toBe("sens:01HZABCDEF1234567890123456");
    expect(k).toMatch(/^sens:[A-Z0-9]+$/);
  });

  it("buildDoc merges top-level risk_class/bucket with payload JSON; strips meta fields", () => {
    const doc = buildDoc({
      risk_class: "GIRR",
      bucket: "USD",
      _hash_tag: "GIRR:USD",
      _id: "01HZ...",
      payload: JSON.stringify({
        sensitivity_type: "Delta",
        tenor: ["3M","6M"],
        risk_value: [0.1,0.2],
        weight_ref: "girr_delta_weights",
        correlation_ref: "girr_corr",
        trade_id: "T1",
      }),
    });
    expect(doc).toEqual({
      risk_class: "GIRR",
      bucket: "USD",
      sensitivity_type: "Delta",
      tenor: ["3M","6M"],
      risk_value: [0.1,0.2],
      weight_ref: "girr_delta_weights",
      correlation_ref: "girr_corr",
      trade_id: "T1",
    });
    // _hash_tag and _id must not leak into the stored JSON doc
    expect(doc).not.toHaveProperty("_hash_tag");
    expect(doc).not.toHaveProperty("_id");
    expect(doc).not.toHaveProperty("payload");
  });
});

// Wave 5.83B — enrichDoc folds per-tenor `weighted_value` (and
// `weighted_cvr_up/down` for Curvature) into every doc before JSON.SET,
// using the schema's risk_weights block, and stamps `_calibration: "demo"`.
// Math correctness is verified to ≤1e-12 (linearity-of-weighting holds
// trivially for IEEE-754 multiplies — only rounding within the multiply
// itself). Per-class fixtures cover all three (3 × class, 3 × leg) variants.
describe("enrichDoc — Wave 5.83B pre-weighting", () => {
  it("stamps _calibration='demo' on every doc, even with no schema", () => {
    const out = enrichDoc({ risk_class: "GIRR", bucket: "USD" });
    expect(out._calibration).toBe(CALIBRATION_TAG);
    expect(out._calibration).toBe("demo");
  });

  it("preserves the raw risk_value and weight fields (purely additive)", () => {
    const rv = { "3M": 0.1, "6M": 0.2 };
    const out = enrichDoc({ risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: rv, weight: 0.017 }, SCHEMA);
    expect(out.risk_value).toEqual(rv);
    expect(out.weight).toBe(0.017);
  });

  // Wave 5.83F — GIRR per-tenor data now lives at `weighted_value_per_tenor`
  // and the bare `weighted_value` carries the scalar signed sum so the
  // NUMERIC index field declared by Equity/FX no longer sees an Object on
  // GIRR-prefix docs.
  it("GIRR Delta per-tenor object → weighted_value_per_tenor object keyed by same tenor labels (≤1e-12)", () => {
    const rv = { "3M": 0.1, "6M": -0.2, "10Y": 0.5 };
    const out = enrichDoc({ risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: rv }, SCHEMA);
    const wv = out.weighted_value_per_tenor as Record<string, number>;
    expect(Object.keys(wv).sort()).toEqual(["10Y", "3M", "6M"]);
    expect(Math.abs(wv["3M"]! - GIRR_W.by_tenor["3M"]! * 0.1)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(wv["6M"]! - GIRR_W.by_tenor["6M"]! * -0.2)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(wv["10Y"]! - GIRR_W.by_tenor["10Y"]! * 0.5)).toBeLessThanOrEqual(TOL);
    // Scalar `weighted_value` is Σ_k WS_k (matches S_b in girr_delta.lua).
    const expectedScalar = GIRR_W.by_tenor["3M"]! * 0.1
      + GIRR_W.by_tenor["6M"]! * -0.2
      + GIRR_W.by_tenor["10Y"]! * 0.5;
    expect(typeof out.weighted_value).toBe("number");
    expect(Math.abs((out.weighted_value as number) - expectedScalar)).toBeLessThanOrEqual(TOL);
  });

  // Wave 5.83B-fix — Vega/Curvature use identity (1.0×s), not the delta
  // weight table. Mirrors the Lua kernels: girr_vega/equity_vega/fx_vega
  // multiply by a vega weight that is 1.0 in the locked schema, and
  // *_curvature.lua applies no weight at all.
  it("GIRR Vega per-tenor object → weighted_value_per_tenor passes the bare sensitivity through (identity)", () => {
    const out = enrichDoc({ risk_class: "GIRR", bucket: "EUR", sensitivity_type: "Vega", risk_value: { "1Y": 0.3 } }, SCHEMA);
    const wv = out.weighted_value_per_tenor as Record<string, number>;
    expect(Math.abs(wv["1Y"]! - 0.3)).toBeLessThanOrEqual(TOL);
    // Sanity: did NOT apply the delta weight (~0.016) which the pre-fix code did.
    expect(wv["1Y"]!).not.toBeCloseTo(GIRR_W.by_tenor["1Y"]! * 0.3, 6);
    // Scalar `weighted_value` is the signed Σ — single tenor here so equals 0.3.
    expect(typeof out.weighted_value).toBe("number");
    expect(Math.abs((out.weighted_value as number) - 0.3)).toBeLessThanOrEqual(TOL);
  });

  it("EQUITY Vega scalar {spot} → weighted_value is identity (1.0×s)", () => {
    const out = enrichDoc({ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Vega", risk_value: { spot: 0.42 } }, SCHEMA);
    expect(Math.abs((out.weighted_value as number) - 0.42)).toBeLessThanOrEqual(TOL);
    expect(out.weighted_value as number).not.toBeCloseTo(EQUITY_W.by_bucket["1"]! * 0.42, 6);
  });

  it("FX Vega scalar {spot} → weighted_value is identity (1.0×s)", () => {
    const out = enrichDoc({ risk_class: "FX", bucket: "EURUSD", sensitivity_type: "Vega", risk_value: { spot: 0.75 } }, SCHEMA);
    expect(Math.abs((out.weighted_value as number) - 0.75)).toBeLessThanOrEqual(TOL);
  });

  it("GIRR legacy array shape zipped via doc.tenor (test-fixture compat)", () => {
    const out = enrichDoc({
      risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
      tenor: ["3M", "1Y", "10Y"], risk_value: [0.1, 0.2, 0.3],
    }, SCHEMA);
    // Wave 5.83F — per-tenor map at `weighted_value_per_tenor`; scalar Σ at `weighted_value`.
    const wv = out.weighted_value_per_tenor as Record<string, number>;
    expect(Math.abs(wv["3M"]! - GIRR_W.by_tenor["3M"]! * 0.1)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(wv["1Y"]! - GIRR_W.by_tenor["1Y"]! * 0.2)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(wv["10Y"]! - GIRR_W.by_tenor["10Y"]! * 0.3)).toBeLessThanOrEqual(TOL);
    const expectedScalar = GIRR_W.by_tenor["3M"]! * 0.1
      + GIRR_W.by_tenor["1Y"]! * 0.2
      + GIRR_W.by_tenor["10Y"]! * 0.3;
    expect(typeof out.weighted_value).toBe("number");
    expect(Math.abs((out.weighted_value as number) - expectedScalar)).toBeLessThanOrEqual(TOL);
  });

  it("EQUITY scalar {spot} → scalar weighted_value via by_bucket", () => {
    const out = enrichDoc({ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta", risk_value: { spot: 0.42 } }, SCHEMA);
    expect(Math.abs((out.weighted_value as number) - EQUITY_W.by_bucket["1"]! * 0.42)).toBeLessThanOrEqual(TOL);
  });

  it("EQUITY bare-number risk_value → scalar weighted_value (legacy fixture shape)", () => {
    const out = enrichDoc({ risk_class: "EQUITY", bucket: "2", sensitivity_type: "Delta", risk_value: 0.5 }, SCHEMA);
    expect(Math.abs((out.weighted_value as number) - EQUITY_W.by_bucket["2"]! * 0.5)).toBeLessThanOrEqual(TOL);
  });

  it("FX scalar → scalar weighted_value via constant weight", () => {
    const out = enrichDoc({ risk_class: "FX", bucket: "EURUSD", sensitivity_type: "Delta", risk_value: { spot: 0.75 } }, SCHEMA);
    expect(Math.abs((out.weighted_value as number) - FX_W.constant * 0.75)).toBeLessThanOrEqual(TOL);
  });

  // Wave 5.83B-fix — Curvature legs are identity. *_curvature.lua applies
  // no schema weight; ψ-gate + max(K_up, K_down) run in the reduce step.
  // Wave 5.83F — per-tenor map at `weighted_cvr_{up,down}_per_tenor`; scalar
  // Σ at `weighted_cvr_{up,down}`.
  it("GIRR Curvature per-tenor arrays → weighted_cvr_*_per_tenor passthrough (identity)", () => {
    const tenors = SCHEMA.risk_classes.GIRR!.tenor!.nodes;
    const up = tenors.map((_, i) => 0.1 * (i + 1));
    const down = tenors.map((_, i) => -0.05 * (i + 1));
    const out = enrichDoc({
      risk_class: "GIRR", bucket: "USD", sensitivity_type: "Curvature",
      risk_value: { cvr_up: up, cvr_down: down },
    }, SCHEMA);
    const wu = out.weighted_cvr_up_per_tenor as Record<string, number>;
    const wd = out.weighted_cvr_down_per_tenor as Record<string, number>;
    expect(out.weighted_value).toBeUndefined();
    let upSum = 0;
    let downSum = 0;
    for (let i = 0; i < tenors.length; i++) {
      const t = tenors[i]!;
      expect(Math.abs(wu[t]! - up[i]!)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(wd[t]! - down[i]!)).toBeLessThanOrEqual(TOL);
      upSum += up[i]!;
      downSum += down[i]!;
    }
    // Sanity: the pre-fix code would have multiplied by GIRR_W.by_tenor here.
    expect(wu[tenors[0]!]!).not.toBeCloseTo(GIRR_W.by_tenor[tenors[0]!]! * up[0]!, 6);
    expect(typeof out.weighted_cvr_up).toBe("number");
    expect(typeof out.weighted_cvr_down).toBe("number");
    expect(Math.abs((out.weighted_cvr_up as number) - upSum)).toBeLessThanOrEqual(TOL);
    expect(Math.abs((out.weighted_cvr_down as number) - downSum)).toBeLessThanOrEqual(TOL);
  });

  it("EQUITY Curvature scalars → scalar weighted_cvr_up / weighted_cvr_down passthrough (identity)", () => {
    const out = enrichDoc({
      risk_class: "EQUITY", bucket: "5", sensitivity_type: "Curvature",
      risk_value: { cvr_up: 0.4, cvr_down: -0.3 },
    }, SCHEMA);
    expect(Math.abs((out.weighted_cvr_up as number) - 0.4)).toBeLessThanOrEqual(TOL);
    expect(Math.abs((out.weighted_cvr_down as number) - -0.3)).toBeLessThanOrEqual(TOL);
    expect(out.weighted_cvr_up as number).not.toBeCloseTo(EQUITY_W.by_bucket["5"]! * 0.4, 6);
  });

  it("FX Curvature scalars → scalar weighted_cvr_up / weighted_cvr_down passthrough (identity)", () => {
    const out = enrichDoc({
      risk_class: "FX", bucket: "EURUSD", sensitivity_type: "Curvature",
      risk_value: { cvr_up: 0.3, cvr_down: -0.2 },
    }, SCHEMA);
    expect(Math.abs((out.weighted_cvr_up as number) - 0.3)).toBeLessThanOrEqual(TOL);
    expect(Math.abs((out.weighted_cvr_down as number) - -0.2)).toBeLessThanOrEqual(TOL);
  });

  it("unknown risk_class → only _calibration stamped, no weighted fields", () => {
    const out = enrichDoc({ risk_class: "UNKNOWN", bucket: "x", sensitivity_type: "Delta", risk_value: { spot: 1 } }, SCHEMA);
    expect(out._calibration).toBe("demo");
    expect(out.weighted_value).toBeUndefined();
  });
});


// Wave 5.30a — unit suite for the per-row SUGADD hook. Drives processBatch
// with a stub client that records every pipeline call so the test can assert
// the exact sequence (JSON.SET → SUGADD×N → XACK) without booting a real
// Redis Stack. Uses processBatch directly because xreadgroup is the only
// non-pipeline call and is straightforward to stub.
interface RecordedPipelineCall { command: string; args: unknown[] }
function pipelineStub(record: RecordedPipelineCall[]): ReturnType<Redis["pipeline"]> {
  const pl = {
    call(command: string, ...args: unknown[]) {
      record.push({ command: command.toUpperCase(), args });
      return pl;
    },
    xack(stream: string, group: string, id: string) {
      record.push({ command: "XACK", args: [stream, group, id] });
      return pl;
    },
    async exec() {
      return record.map(() => [null, "OK"] as [Error | null, unknown]);
    },
  };
  return pl as unknown as ReturnType<Redis["pipeline"]>;
}

describe("consumer SUGADD live-populate hook [Wave 5.30a]", () => {
  it("emits one SUGADD per non-null tenant field per row, between JSON.SET and XACK", async () => {
    const record: RecordedPipelineCall[] = [];
    const stub = {
      pipeline: () => pipelineStub(record),
      async xreadgroup(..._a: unknown[]) {
        // Two rows: first has all three fields, second has only trade_id.
        return [[
          "sensitivities:in",
          [
            ["1-0", [
              "risk_class", "GIRR",
              "bucket", "USD",
              "_hash_tag", "GIRR:USD",
              "_id", "01HZA",
              "payload", JSON.stringify({ trade_id: "T0001", risk_factor: "RF_GIRR_01", book: "RATES-LDN" }),
            ]],
            ["2-0", [
              "risk_class", "EQUITY",
              "bucket", "1",
              "_hash_tag", "EQUITY:1",
              "_id", "01HZB",
              "payload", JSON.stringify({ trade_id: "T0002" }),
            ]],
          ],
        ]];
      },
    } as unknown as Redis;
    const n = await processBatch(stub, { stream: "sensitivities:in", group: "ingest", consumerName: "c1" }, ">");
    expect(n).toBe(2);

    const sugadds = record.filter((r) => r.command === "FT.SUGADD");
    // Row 1 contributes 3 (book + trade_id + risk_factor), row 2 contributes 1 (trade_id only) = 4 total.
    expect(sugadds).toHaveLength(4);
    // Each carries the value, score "1", and INCR mode.
    for (const c of sugadds) {
      expect(c.args[2]).toBe("1");
      expect(c.args[3]).toBe("INCR");
    }
    const bookCalls = sugadds.filter((c) => c.args[0] === "sug:book");
    expect(bookCalls).toHaveLength(1);
    expect(bookCalls[0]!.args[1]).toBe("RATES-LDN");
    const tradeCalls = sugadds.filter((c) => c.args[0] === "sug:trade_id");
    expect(tradeCalls.map((c) => c.args[1]).sort()).toEqual(["T0001", "T0002"]);
    const factorCalls = sugadds.filter((c) => c.args[0] === "sug:risk_factor");
    expect(factorCalls.map((c) => c.args[1])).toEqual(["RF_GIRR_01"]);

    // Order check: every SUGADD must appear AFTER its preceding JSON.SET and
    // BEFORE the matching XACK so a SUGADD pipeline-level failure prevents
    // the entry leaving the PEL.
    const jsonSetIdxs = record.map((r, i) => (r.command === "JSON.SET" ? i : -1)).filter((i) => i >= 0);
    const sugIdxs = record.map((r, i) => (r.command === "FT.SUGADD" ? i : -1)).filter((i) => i >= 0);
    const xackIdxs = record.map((r, i) => (r.command === "XACK" ? i : -1)).filter((i) => i >= 0);
    expect(jsonSetIdxs).toHaveLength(2);
    expect(xackIdxs).toHaveLength(2);
    // First row block: JSON.SET[0] < every SUGADD for that row < XACK[0].
    expect(sugIdxs[0]).toBeGreaterThan(jsonSetIdxs[0]!);
    expect(sugIdxs[2]).toBeLessThan(xackIdxs[0]!);
  });
});

// Integration tests run only when JSON.SET is available on the local Redis.
// Per Wave 1 follow-up #1, use it.skipIf() not the legacy if-guard pattern so
// coverage stays visible. In CI / on demo workstations redis-stack-server is
// expected to be on PATH and JSON ships with the locked Redis Enterprise 8.x runtime.
//
// Wave 5.73f: gate on the synchronous on-disk module check directly —
// it.skipIf is evaluated eagerly at collection time, before beforeAll has
// set redisAvailable/jsonAvailable. STACK_BUNDLED_PRESENT is the
// boot-success precondition in CI.
const integration = (label: string, fn: () => Promise<void> | void) =>
  it.skipIf(!STACK_BUNDLED_PRESENT)(label, fn);

describe("XREADGROUP consumer → JSON.SET", () => {
  integration("ensureGroup creates the consumer group with MKSTREAM (idempotent on BUSYGROUP)", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    await ensureGroup(redis, "sensitivities:in", "ingest"); // second call is a no-op
    const groups = await redis.xinfo("GROUPS", "sensitivities:in") as unknown[];
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBe(1);
  });

  integration("writes one JSON doc per stream entry at sens:{ulid} and XACKs it", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const rows = [
      makeRow("GIRR", "USD", { sensitivity_type: "Delta", tenor: ["3M","1Y","10Y"], risk_value: [0.1,0.2,0.3], weight_ref: "girr_delta_weights", correlation_ref: "girr_corr", trade_id: "T1" }),
      makeRow("EQUITY", "1", { sensitivity_type: "Delta", risk_value: 0.5, weight_ref: "equity_delta_weights", correlation_ref: "equity_corr", trade_id: "T2" }),
      makeRow("FX", "USDEUR", { sensitivity_type: "Vega", risk_value: 0.75, weight_ref: "fx_weights", correlation_ref: "fx_corr", trade_id: "T3" }),
    ];
    for (const r of rows) await xaddRow("sensitivities:in", r);

    const processed = await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1", batchSize: 100,
    }, ">");
    expect(processed).toBe(3);

    const keys = await redis.keys("sens:*");
    expect(keys).toHaveLength(3);
    const literalKeyShape = /^sens:[A-Z0-9]+$/;
    for (const k of keys) expect(k, `key ${k} must match locked pattern`).toMatch(literalKeyShape);

    // XPENDING reports zero pending entries for the group after successful ack
    const pending = await redis.xpending("sensitivities:in", "ingest") as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });

  integration("stored JSON doc shape matches the locked Wave 2 contract", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const row = makeRow("GIRR", "USD-IRS", {
      sensitivity_type: "Delta",
      tenor: [0.25, 0.5, 1, 2, 3, 5, 10, 15, 20, 30],
      risk_value: [0.12, 0.34, 0.5, 0.6, 0.7, 0.65, 0.5, 0.4, 0.3, 0.2],
      weight_ref: "girr_delta_weights",
      correlation_ref: "girr_corr",
      trade_id: "T-7",
      book: "RATES-LDN",
    });
    await xaddRow("sensitivities:in", row);
    await processBatch(redis, { stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1" }, ">");

    const key = `sens:${row._id}`;
    const stored = JSON.parse(await redis.call("JSON.GET", key) as string);
    expect(stored).toMatchObject({
      risk_class: "GIRR",
      bucket: "USD-IRS",
      sensitivity_type: "Delta",
      weight_ref: "girr_delta_weights",
      correlation_ref: "girr_corr",
      trade_id: "T-7",
      book: "RATES-LDN",
    });
    expect(Array.isArray(stored.tenor)).toBe(true);
    expect(stored.tenor).toHaveLength(10);
    expect(Array.isArray(stored.risk_value)).toBe(true);
    expect(stored.risk_value).toHaveLength(10);
    // meta fields used only for routing must not leak into the stored doc
    expect(stored).not.toHaveProperty("_hash_tag");
    expect(stored).not.toHaveProperty("_id");
    expect(stored).not.toHaveProperty("payload");
  });

  integration("is idempotent — re-running on the same logical rows produces no duplicate keys", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeRow("GIRR", "USD", { sensitivity_type: "Delta", risk_value: [i, i+1], trade_id: `T-${i}` })
    );
    for (const r of rows) await xaddRow("sensitivities:in", r);

    await processBatch(redis, { stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1" }, ">");
    expect((await redis.keys("sens:*")).length).toBe(25);

    // Re-deliver the SAME logical rows (same _id ULIDs) under fresh XADD ids — a
    // second generator run replaying its buffer must not double-write docs.
    for (const r of rows) await xaddRow("sensitivities:in", r);
    await processBatch(redis, { stream: "sensitivities:in", group: "ingest", consumerName: "ingest-1" }, ">");
    expect((await redis.keys("sens:*")).length).toBe(25);
  });

  integration("createConsumer runs an XREADGROUP loop and drains on stop()", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const rows = Array.from({ length: 50 }, () =>
      makeRow("EQUITY", "2", { sensitivity_type: "Delta", risk_value: 1.23 })
    );
    for (const r of rows) await xaddRow("sensitivities:in", r);

    const runner = createConsumer(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-runner", batchSize: 64, blockMs: 50,
    });
    runner.start();
    // Poll until all 50 docs are visible (cap at 5s wall-clock)
    for (let i = 0; i < 50 && (await redis.keys("sens:*")).length < 50; i++) await wait(100);
    await runner.stop();

    expect((await redis.keys("sens:*")).length).toBe(50);
    expect(runner.stats.acked).toBeGreaterThanOrEqual(50);
  });

  // Wave 5.83B — end-to-end check that the consumer writes the pre-weighted
  // fields and the `_calibration` tag through JSON.SET. Uses the locked
  // default schema so the assertions are byte-identical to a production
  // deployment.
  integration("with schema, stored doc includes weighted_value (≤1e-12 of w*s) and _calibration='demo'", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const girr = makeRow("GIRR", "USD", {
      sensitivity_type: "Delta",
      tenor: ["3M", "1Y", "10Y"],
      risk_value: [0.1, 0.2, 0.3],
      trade_id: "T-w1",
    });
    const equity = makeRow("EQUITY", "1", { sensitivity_type: "Delta", risk_value: { spot: 0.42 }, trade_id: "T-w2" });
    const fx = makeRow("FX", "EURUSD", { sensitivity_type: "Delta", risk_value: { spot: 0.75 }, trade_id: "T-w3" });
    for (const r of [girr, equity, fx]) await xaddRow("sensitivities:in", r);

    await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-w", batchSize: 100, schema: SCHEMA,
    }, ">");

    const girrStored = JSON.parse(await redis.call("JSON.GET", `sens:${girr._id}`) as string);
    expect(girrStored._calibration).toBe("demo");
    // Wave 5.83F — per-tenor map at `weighted_value_per_tenor`; scalar Σ at `weighted_value`.
    const gwv = girrStored.weighted_value_per_tenor as Record<string, number>;
    expect(Math.abs(gwv["3M"] - GIRR_W.by_tenor["3M"]! * 0.1)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(gwv["1Y"] - GIRR_W.by_tenor["1Y"]! * 0.2)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(gwv["10Y"] - GIRR_W.by_tenor["10Y"]! * 0.3)).toBeLessThanOrEqual(TOL);
    const expectedScalar = GIRR_W.by_tenor["3M"]! * 0.1
      + GIRR_W.by_tenor["1Y"]! * 0.2
      + GIRR_W.by_tenor["10Y"]! * 0.3;
    expect(typeof girrStored.weighted_value).toBe("number");
    expect(Math.abs((girrStored.weighted_value as number) - expectedScalar)).toBeLessThanOrEqual(TOL);
    // Raw fields preserved
    expect(girrStored.risk_value).toEqual([0.1, 0.2, 0.3]);

    const eqStored = JSON.parse(await redis.call("JSON.GET", `sens:${equity._id}`) as string);
    expect(eqStored._calibration).toBe("demo");
    expect(Math.abs(eqStored.weighted_value - EQUITY_W.by_bucket["1"]! * 0.42)).toBeLessThanOrEqual(TOL);

    const fxStored = JSON.parse(await redis.call("JSON.GET", `sens:${fx._id}`) as string);
    expect(fxStored._calibration).toBe("demo");
    expect(Math.abs(fxStored.weighted_value - FX_W.constant * 0.75)).toBeLessThanOrEqual(TOL);
  });

  // Wave 5.83B — backfill CLI: seeds an unpatched doc directly via JSON.SET,
  // runs backfill(), then re-runs to verify idempotency. Reports
  // {patched, skipped} consistent with the seeded population.
  integration("backfill patches docs missing weighted_value, then re-runs as a no-op", async () => {
    // Seed three docs WITHOUT _calibration / weighted_* (mimics 5.83A-era data).
    const seeds = [
      { key: "sens:bf01", doc: { risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1, "6M": 0.2 } } },
      { key: "sens:bf02", doc: { risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta", risk_value: { spot: 0.5 } } },
      { key: "sens:bf03", doc: { risk_class: "FX", bucket: "EURUSD", sensitivity_type: "Curvature", risk_value: { cvr_up: 0.3, cvr_down: -0.2 } } },
    ];
    for (const { key, doc } of seeds) {
      await redis.call("JSON.SET", key, "$", JSON.stringify(doc));
    }
    // Also seed one already-enriched doc (new Wave-5.83F shape) so we
    // exercise the skip path: scalar Σ at `weighted_value`, per-tenor map at
    // `weighted_value_per_tenor`.
    await redis.call("JSON.SET", "sens:bf04", "$", JSON.stringify({
      risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
      risk_value: { "3M": 0.5 },
      weighted_value: GIRR_W.by_tenor["3M"]! * 0.5,
      weighted_value_per_tenor: { "3M": GIRR_W.by_tenor["3M"]! * 0.5 },
      _calibration: "demo",
    }));

    const first = await backfill(redis, SCHEMA);
    expect(first.patched).toBe(3);
    expect(first.skipped).toBe(1);
    expect(first.errors).toBe(0);

    // Verify the patches landed and raw fields preserved.
    const girrAfter = JSON.parse(await redis.call("JSON.GET", "sens:bf01") as string);
    expect(girrAfter._calibration).toBe("demo");
    const girrAfterMap = girrAfter.weighted_value_per_tenor as Record<string, number>;
    expect(Math.abs(girrAfterMap["3M"]! - GIRR_W.by_tenor["3M"]! * 0.1)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(girrAfterMap["6M"]! - GIRR_W.by_tenor["6M"]! * 0.2)).toBeLessThanOrEqual(TOL);
    const girrAfterSum = GIRR_W.by_tenor["3M"]! * 0.1 + GIRR_W.by_tenor["6M"]! * 0.2;
    expect(typeof girrAfter.weighted_value).toBe("number");
    expect(Math.abs((girrAfter.weighted_value as number) - girrAfterSum)).toBeLessThanOrEqual(TOL);
    expect(girrAfter.risk_value).toEqual({ "3M": 0.1, "6M": 0.2 });
    // Wave 5.83B-fix — Curvature legs are identity, not FX_W-weighted.
    const fxAfter = JSON.parse(await redis.call("JSON.GET", "sens:bf03") as string);
    expect(Math.abs(fxAfter.weighted_cvr_up - 0.3)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(fxAfter.weighted_cvr_down - -0.2)).toBeLessThanOrEqual(TOL);

    // Second run (default mode) is a pure no-op — everything is already enriched.
    const second = await backfill(redis, SCHEMA);
    expect(second.patched).toBe(0);
    expect(second.skipped).toBe(4);
    expect(second.errors).toBe(0);
  });

  // Wave 5.83B-fix — force mode re-weights every doc so docs ingested under
  // the old (delta-weight-for-all-legs) rule get corrected on next run.
  // Wave 5.83F — stale doc uses the new shape (scalar `weighted_value` +
  // `weighted_value_per_tenor` map) but with the WRONG values; default mode
  // still skips it (shape matches), force mode recomputes both fields.
  integration("backfill --force re-runs enrichDoc on already-tagged docs", async () => {
    const staleKey = "sens:bfforce01";
    const wrongWs = GIRR_W.by_tenor["1Y"]! * 0.3;  // pre-fix WRONG identity-violating value
    const stale = {
      risk_class: "GIRR", bucket: "USD", sensitivity_type: "Vega",
      risk_value: { "1Y": 0.3 },
      weighted_value: wrongWs,
      weighted_value_per_tenor: { "1Y": wrongWs },
      _calibration: "demo",
    };
    await redis.call("JSON.SET", staleKey, "$", JSON.stringify(stale));

    // Default mode skips it (idempotent).
    const noForce = await backfill(redis, SCHEMA);
    expect(noForce.patched).toBe(0);
    expect(noForce.skipped).toBe(1);
    const stillStale = JSON.parse(await redis.call("JSON.GET", staleKey) as string);
    expect(stillStale.weighted_value_per_tenor["1Y"]).toBeCloseTo(wrongWs, 12);

    // Force mode re-weights it to the identity value (1.0×s).
    const forced = await backfill(redis, SCHEMA, { force: true });
    expect(forced.patched).toBe(1);
    expect(forced.skipped).toBe(0);
    const corrected = JSON.parse(await redis.call("JSON.GET", staleKey) as string);
    expect(corrected.weighted_value_per_tenor["1Y"]).toBeCloseTo(0.3, 12);
    expect(corrected.weighted_value).toBeCloseTo(0.3, 12);
    // Raw risk_value untouched.
    expect(corrected.risk_value).toEqual({ "1Y": 0.3 });
  });
});


// Wave 6.14a — incremental per-bucket rollup hashes written alongside JSON.SET.
// The pure-helper tests below drive `emitRollupHincrs` against the recording
// pipeline stub so we can assert the exact HINCRBYFLOAT field set without a
// live Redis. The integration tests below those XADD a known fixture, run
// processBatch, and HGETALL the rollup keys to assert the post-batch totals
// match a direct Σ over the docs.

describe("emitRollupHincrs — Wave 6.14a", () => {
  it("Equity Delta scalar → base rollup with sum_ws / sum_ws_sq / count only", () => {
    const record: RecordedPipelineCall[] = [];
    const stub = pipelineStub(record);
    const doc = enrichDoc({ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta", risk_value: { spot: 0.5 } }, SCHEMA);
    emitRollupHincrs(stub as unknown as { call: (cmd: string, ...args: unknown[]) => unknown }, doc);
    const hincr = record.filter((r) => r.command === "HINCRBYFLOAT");
    expect(hincr).toHaveLength(3);
    const baseKey = rollupKey("EQUITY", "1", "Delta");
    expect(hincr.every((c) => c.args[0] === baseKey)).toBe(true);
    const ws = EQUITY_W.by_bucket["1"]! * 0.5;
    const byField = Object.fromEntries(hincr.map((c) => [c.args[1] as string, c.args[2] as string]));
    expect(Number(byField.sum_ws)).toBeCloseTo(ws, 12);
    expect(Number(byField.sum_ws_sq)).toBeCloseTo(ws * ws, 12);
    expect(byField.count).toBe("1");
  });

  it("GIRR Delta per-tenor → base scalar rollup + one per-tenor rollup per tenor key", () => {
    const record: RecordedPipelineCall[] = [];
    const stub = pipelineStub(record);
    const rv = { "3M": 0.1, "1Y": 0.2, "10Y": 0.3 };
    const doc = enrichDoc({ risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", risk_value: rv }, SCHEMA);
    emitRollupHincrs(stub as unknown as { call: (cmd: string, ...args: unknown[]) => unknown }, doc);
    const hincr = record.filter((r) => r.command === "HINCRBYFLOAT");
    // 3 fields × (1 base + 3 tenors) = 12 calls
    expect(hincr).toHaveLength(12);
    const baseKey = rollupKey("GIRR", "USD-IRS", "Delta");
    const baseHincr = hincr.filter((c) => c.args[0] === baseKey);
    expect(baseHincr).toHaveLength(3);
    const scalar = (doc.weighted_value as number);
    const baseByField = Object.fromEntries(baseHincr.map((c) => [c.args[1] as string, c.args[2] as string]));
    expect(Number(baseByField.sum_ws)).toBeCloseTo(scalar, 12);
    expect(Number(baseByField.sum_ws_sq)).toBeCloseTo(scalar * scalar, 12);
    expect(baseByField.count).toBe("1");
    for (const t of ["3M", "1Y", "10Y"] as const) {
      const tKey = rollupKey("GIRR", "USD-IRS", "Delta", t);
      const tHincr = hincr.filter((c) => c.args[0] === tKey);
      expect(tHincr).toHaveLength(3);
      const wst = GIRR_W.by_tenor[t]! * rv[t]!;
      const byField = Object.fromEntries(tHincr.map((c) => [c.args[1] as string, c.args[2] as string]));
      expect(Number(byField.sum_ws)).toBeCloseTo(wst, 12);
      expect(Number(byField.sum_ws_sq)).toBeCloseTo(wst * wst, 12);
      expect(byField.count).toBe("1");
    }
  });

  it("Equity Curvature scalar → base rollup with sign-split fields (sum_ws_up / sum_ws_up_sq / sum_ws_down / sum_ws_down_sq / count)", () => {
    const record: RecordedPipelineCall[] = [];
    const stub = pipelineStub(record);
    const doc = enrichDoc({ risk_class: "EQUITY", bucket: "5", sensitivity_type: "Curvature", risk_value: { cvr_up: 0.4, cvr_down: -0.3 } }, SCHEMA);
    emitRollupHincrs(stub as unknown as { call: (cmd: string, ...args: unknown[]) => unknown }, doc);
    const hincr = record.filter((r) => r.command === "HINCRBYFLOAT");
    expect(hincr).toHaveLength(5);
    const baseKey = rollupKey("EQUITY", "5", "Curvature");
    expect(hincr.every((c) => c.args[0] === baseKey)).toBe(true);
    const byField = Object.fromEntries(hincr.map((c) => [c.args[1] as string, c.args[2] as string]));
    expect(Number(byField.sum_ws_up)).toBeCloseTo(0.4, 12);
    expect(Number(byField.sum_ws_up_sq)).toBeCloseTo(0.16, 12);
    expect(Number(byField.sum_ws_down)).toBeCloseTo(-0.3, 12);
    expect(Number(byField.sum_ws_down_sq)).toBeCloseTo(0.09, 12);
    expect(byField.count).toBe("1");
    expect(byField.sum_ws).toBeUndefined();
  });

  it("GIRR Curvature per-tenor → base sign-split rollup + per-tenor sign-split rollups", () => {
    const record: RecordedPipelineCall[] = [];
    const stub = pipelineStub(record);
    const tenors = SCHEMA.risk_classes.GIRR!.tenor!.nodes;
    const up = tenors.map((_, i) => 0.1 * (i + 1));
    const down = tenors.map((_, i) => -0.05 * (i + 1));
    const doc = enrichDoc({
      risk_class: "GIRR", bucket: "USD", sensitivity_type: "Curvature",
      risk_value: { cvr_up: up, cvr_down: down },
    }, SCHEMA);
    emitRollupHincrs(stub as unknown as { call: (cmd: string, ...args: unknown[]) => unknown }, doc);
    const hincr = record.filter((r) => r.command === "HINCRBYFLOAT");
    expect(hincr).toHaveLength(5 * (1 + tenors.length));
    const baseKey = rollupKey("GIRR", "USD", "Curvature");
    const baseHincr = hincr.filter((c) => c.args[0] === baseKey);
    expect(baseHincr).toHaveLength(5);
    const upSum = up.reduce((a, b) => a + b, 0);
    const downSum = down.reduce((a, b) => a + b, 0);
    const baseByField = Object.fromEntries(baseHincr.map((c) => [c.args[1] as string, c.args[2] as string]));
    expect(Number(baseByField.sum_ws_up)).toBeCloseTo(upSum, 12);
    expect(Number(baseByField.sum_ws_up_sq)).toBeCloseTo(upSum * upSum, 12);
    expect(Number(baseByField.sum_ws_down)).toBeCloseTo(downSum, 12);
    expect(Number(baseByField.sum_ws_down_sq)).toBeCloseTo(downSum * downSum, 12);
    for (let i = 0; i < tenors.length; i++) {
      const t = tenors[i]!;
      const tKey = rollupKey("GIRR", "USD", "Curvature", t);
      const tHincr = hincr.filter((c) => c.args[0] === tKey);
      expect(tHincr).toHaveLength(5);
      const byField = Object.fromEntries(tHincr.map((c) => [c.args[1] as string, c.args[2] as string]));
      expect(Number(byField.sum_ws_up)).toBeCloseTo(up[i]!, 12);
      expect(Number(byField.sum_ws_up_sq)).toBeCloseTo(up[i]! * up[i]!, 12);
      expect(Number(byField.sum_ws_down)).toBeCloseTo(down[i]!, 12);
      expect(Number(byField.sum_ws_down_sq)).toBeCloseTo(down[i]! * down[i]!, 12);
    }
  });

  it("no risk_class / bucket / sensitivity_type → no rollup writes", () => {
    const record: RecordedPipelineCall[] = [];
    const stub = pipelineStub(record);
    emitRollupHincrs(stub as unknown as { call: (cmd: string, ...args: unknown[]) => unknown }, { risk_class: "GIRR", bucket: "USD" });
    expect(record.filter((r) => r.command === "HINCRBYFLOAT")).toHaveLength(0);
  });
});

describe("processBatch rollup HINCRBYFLOAT integration [Wave 6.14a]", () => {
  integration("mixed 1000-row fixture → HGETALL on rollup keys matches the manual Σ over docs", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    // Three buckets / sens combos exercised in one batch. Deterministic
    // risk values so the expected Σ is computable from the fixture alone.
    const N_EACH = 200;
    type Combo = { rc: string; bkt: string; sens: string; mk: (i: number) => Record<string, unknown> };
    const combos: Combo[] = [
      { rc: "GIRR", bkt: "USD-IRS", sens: "Delta", mk: (i) => ({ sensitivity_type: "Delta", risk_value: { "3M": 0.001 * (i + 1), "1Y": 0.002 * (i + 1), "10Y": -0.0005 * (i + 1) }, trade_id: `T-G-${i}` }) },
      { rc: "EQUITY", bkt: "1", sens: "Delta", mk: (i) => ({ sensitivity_type: "Delta", risk_value: { spot: 0.01 * (i + 1) }, trade_id: `T-E-${i}` }) },
      { rc: "FX", bkt: "EURUSD", sens: "Delta", mk: (i) => ({ sensitivity_type: "Delta", risk_value: { spot: 0.02 * (i + 1) }, trade_id: `T-F-${i}` }) },
      { rc: "EQUITY", bkt: "5", sens: "Curvature", mk: (i) => ({ sensitivity_type: "Curvature", risk_value: { cvr_up: 0.1 * (i + 1), cvr_down: -0.05 * (i + 1) }, trade_id: `T-EC-${i}` }) },
      { rc: "GIRR", bkt: "USD", sens: "Curvature", mk: (i) => {
        const tenors = SCHEMA.risk_classes.GIRR!.tenor!.nodes;
        const up = tenors.map((_, k) => 0.001 * (i + 1) * (k + 1));
        const down = tenors.map((_, k) => -0.0005 * (i + 1) * (k + 1));
        return { sensitivity_type: "Curvature", risk_value: { cvr_up: up, cvr_down: down }, trade_id: `T-GC-${i}` };
      } },
    ];
    // 5 combos × 200 rows = 1000 rows in one batch.
    const rows: Array<{ combo: Combo; row: ReturnType<typeof makeRow>; doc: Record<string, unknown> }> = [];
    for (const c of combos) {
      for (let i = 0; i < N_EACH; i++) {
        const payload = c.mk(i);
        const row = makeRow(c.rc, c.bkt, payload);
        const doc = enrichDoc(buildDoc({ ...row }), SCHEMA);
        rows.push({ combo: c, row, doc });
      }
    }
    // Shuffle the XADD order so the rollup arithmetic is exercised under
    // interleaved fan-in across combos (Σ in Redis vs. Σ in JS must agree
    // regardless of the order of pipelined HINCRBYFLOATs).
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i]!, rows[j]!] = [rows[j]!, rows[i]!];
    }
    for (const { row } of rows) await xaddRow("sensitivities:in", row);

    const processed = await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-rollup", batchSize: 2000, schema: SCHEMA,
    }, ">");
    expect(processed).toBe(rows.length);

    // Build expected rollup totals from the JS-enriched docs (single pass).
    type Acc = { sum_ws?: number; sum_ws_sq?: number; sum_ws_up?: number; sum_ws_up_sq?: number; sum_ws_down?: number; sum_ws_down_sq?: number; count: number };
    const acc = new Map<string, Acc>();
    const bump = (key: string, patch: Partial<Acc>) => {
      const cur = acc.get(key) ?? { count: 0 };
      for (const [k, v] of Object.entries(patch)) {
        if (k === "count") cur.count += v as number;
        else (cur as unknown as Record<string, number>)[k] = ((cur as unknown as Record<string, number>)[k] ?? 0) + (v as number);
      }
      acc.set(key, cur);
    };
    for (const { combo, doc } of rows) {
      const { rc, bkt, sens } = combo;
      if (sens === "Curvature") {
        const up = doc.weighted_cvr_up as number;
        const down = doc.weighted_cvr_down as number;
        bump(rollupKey(rc, bkt, sens), { sum_ws_up: up, sum_ws_up_sq: up * up, sum_ws_down: down, sum_ws_down_sq: down * down, count: 1 });
        const upMap = doc.weighted_cvr_up_per_tenor as Record<string, number> | undefined;
        const downMap = doc.weighted_cvr_down_per_tenor as Record<string, number> | undefined;
        if (upMap && downMap) {
          for (const t of Object.keys(upMap)) {
            const u = upMap[t]!;
            const d = downMap[t]!;
            bump(rollupKey(rc, bkt, sens, t), { sum_ws_up: u, sum_ws_up_sq: u * u, sum_ws_down: d, sum_ws_down_sq: d * d, count: 1 });
          }
        }
      } else {
        const ws = doc.weighted_value as number;
        bump(rollupKey(rc, bkt, sens), { sum_ws: ws, sum_ws_sq: ws * ws, count: 1 });
        const perTenor = doc.weighted_value_per_tenor as Record<string, number> | undefined;
        if (perTenor) {
          for (const t of Object.keys(perTenor)) {
            const v = perTenor[t]!;
            bump(rollupKey(rc, bkt, sens, t), { sum_ws: v, sum_ws_sq: v * v, count: 1 });
          }
        }
      }
    }

    // Every expected key must HGETALL with matching fields. Σ-of-many floats
    // through HINCRBYFLOAT (vs. JS Σ) introduces accumulation rounding; 1e-6
    // is comfortably above the noise floor for N=200 increments per key.
    const ROLLUP_TOL = 1e-6;
    for (const [key, want] of acc.entries()) {
      const got = await redis.hgetall(key);
      expect(Object.keys(got).length, `rollup ${key} should have fields`).toBeGreaterThan(0);
      expect(Number(got.count)).toBe(want.count);
      if (want.sum_ws != null) expect(Math.abs(Number(got.sum_ws) - want.sum_ws)).toBeLessThanOrEqual(ROLLUP_TOL);
      if (want.sum_ws_sq != null) expect(Math.abs(Number(got.sum_ws_sq) - want.sum_ws_sq)).toBeLessThanOrEqual(ROLLUP_TOL);
      if (want.sum_ws_up != null) expect(Math.abs(Number(got.sum_ws_up) - want.sum_ws_up)).toBeLessThanOrEqual(ROLLUP_TOL);
      if (want.sum_ws_up_sq != null) expect(Math.abs(Number(got.sum_ws_up_sq) - want.sum_ws_up_sq)).toBeLessThanOrEqual(ROLLUP_TOL);
      if (want.sum_ws_down != null) expect(Math.abs(Number(got.sum_ws_down) - want.sum_ws_down)).toBeLessThanOrEqual(ROLLUP_TOL);
      if (want.sum_ws_down_sq != null) expect(Math.abs(Number(got.sum_ws_down_sq) - want.sum_ws_down_sq)).toBeLessThanOrEqual(ROLLUP_TOL);
    }

    // GIRR per-tenor sub-rollups must exist for every tenor in the schema.
    const girrTenors = SCHEMA.risk_classes.GIRR!.tenor!.nodes;
    for (const t of ["3M", "1Y", "10Y"]) {
      expect(acc.has(rollupKey("GIRR", "USD-IRS", "Delta", t))).toBe(true);
    }
    for (const t of girrTenors) {
      const k = rollupKey("GIRR", "USD", "Curvature", t);
      const got = await redis.hgetall(k);
      expect(Number(got.count)).toBe(N_EACH);
    }
  });

  integration("idempotency: re-running processBatch with no new entries leaves rollups unchanged", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow("EQUITY", "2", { sensitivity_type: "Delta", risk_value: { spot: 0.1 * (i + 1) }, trade_id: `T-idem-${i}` })
    );
    for (const r of rows) await xaddRow("sensitivities:in", r);
    await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-idem", batchSize: 100, schema: SCHEMA,
    }, ">");

    const key = rollupKey("EQUITY", "2", "Delta");
    const first = await redis.hgetall(key);
    expect(Number(first.count)).toBe(30);

    // Second processBatch call with no new XADDs — XREADGROUP returns null,
    // no HINCRBYFLOATs fire, the rollup hash is untouched.
    const processed = await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-idem", batchSize: 100, schema: SCHEMA,
    }, ">", 100);
    expect(processed).toBe(0);
    const second = await redis.hgetall(key);
    expect(second).toEqual(first);
  });

  integration("Curvature sign-split lives on the base rollup key and per-tenor sub-rollups (GIRR)", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const tenors = SCHEMA.risk_classes.GIRR!.tenor!.nodes;
    const up = tenors.map((_, i) => 0.2 * (i + 1));
    const down = tenors.map((_, i) => -0.1 * (i + 1));
    const row = makeRow("GIRR", "JPY", { sensitivity_type: "Curvature", risk_value: { cvr_up: up, cvr_down: down }, trade_id: "T-CG-1" });
    await xaddRow("sensitivities:in", row);
    await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-cv-girr", batchSize: 10, schema: SCHEMA,
    }, ">");

    const baseKey = rollupKey("GIRR", "JPY", "Curvature");
    const base = await redis.hgetall(baseKey);
    const upSum = up.reduce((a, b) => a + b, 0);
    const downSum = down.reduce((a, b) => a + b, 0);
    expect(Math.abs(Number(base.sum_ws_up) - upSum)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(Number(base.sum_ws_down) - downSum)).toBeLessThanOrEqual(1e-9);
    expect(Number(base.count)).toBe(1);
    // No scalar field name leaks on the Curvature rollup.
    expect(base.sum_ws).toBeUndefined();

    for (let i = 0; i < tenors.length; i++) {
      const t = tenors[i]!;
      const sub = await redis.hgetall(rollupKey("GIRR", "JPY", "Curvature", t));
      expect(Math.abs(Number(sub.sum_ws_up) - up[i]!)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(Number(sub.sum_ws_down) - down[i]!)).toBeLessThanOrEqual(1e-12);
      expect(Number(sub.count)).toBe(1);
    }
  });
});


// Wave 6.14c — one-shot rollup backfill walks existing sens:* docs and
// rebuilds rollup hashes via HSET. Pure-helper test asserts the accumulator
// matches a manual Σ; integration tests drive a live Redis fixture, drop
// the rollups, rerun the backfill, and check the rebuilt hashes match the
// originals + re-running is idempotent.
describe("backfillRollups — Wave 6.14c", () => {
  it("accumulateRollup matches the manual Σ across mixed combos", () => {
    const scalar = new Map<string, { sum_ws: number; sum_ws_sq: number; count: number }>();
    const curvature = new Map<string, { sum_ws_up: number; sum_ws_up_sq: number; sum_ws_down: number; sum_ws_down_sq: number; count: number }>();
    const docs = [
      enrichDoc({ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta", risk_value: { spot: 0.5 } }, SCHEMA),
      enrichDoc({ risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta", risk_value: { spot: 0.25 } }, SCHEMA),
      enrichDoc({ risk_class: "EQUITY", bucket: "5", sensitivity_type: "Curvature", risk_value: { cvr_up: 0.4, cvr_down: -0.3 } }, SCHEMA),
    ];
    for (const d of docs) accumulateRollup(d, scalar, curvature);
    const eqKey = rollupKey("EQUITY", "1", "Delta");
    const ws1 = EQUITY_W.by_bucket["1"]! * 0.5;
    const ws2 = EQUITY_W.by_bucket["1"]! * 0.25;
    const a = scalar.get(eqKey)!;
    expect(a.count).toBe(2);
    expect(Math.abs(a.sum_ws - (ws1 + ws2))).toBeLessThanOrEqual(TOL);
    expect(Math.abs(a.sum_ws_sq - (ws1 * ws1 + ws2 * ws2))).toBeLessThanOrEqual(TOL);
    const cvKey = rollupKey("EQUITY", "5", "Curvature");
    const c = curvature.get(cvKey)!;
    expect(c.count).toBe(1);
    expect(Math.abs(c.sum_ws_up - 0.4)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(c.sum_ws_down - -0.3)).toBeLessThanOrEqual(TOL);
  });

  integration("rebuild from sens:* docs matches a fresh consumer-driven rollup; re-run is idempotent", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    const combos = [
      { rc: "EQUITY", bkt: "1", sens: "Delta", mk: (i: number) => ({ sensitivity_type: "Delta", risk_value: { spot: 0.01 * (i + 1) }, trade_id: `T-E-${i}` }) },
      { rc: "FX", bkt: "EURUSD", sens: "Delta", mk: (i: number) => ({ sensitivity_type: "Delta", risk_value: { spot: 0.02 * (i + 1) }, trade_id: `T-F-${i}` }) },
      { rc: "EQUITY", bkt: "5", sens: "Curvature", mk: (i: number) => ({ sensitivity_type: "Curvature", risk_value: { cvr_up: 0.1 * (i + 1), cvr_down: -0.05 * (i + 1) }, trade_id: `T-EC-${i}` }) },
      { rc: "GIRR", bkt: "USD-IRS", sens: "Delta", mk: (i: number) => ({ sensitivity_type: "Delta", risk_value: { "3M": 0.001 * (i + 1), "1Y": 0.002 * (i + 1), "10Y": -0.0005 * (i + 1) }, trade_id: `T-G-${i}` }) },
    ];
    const N_EACH = 12;
    for (const c of combos) {
      for (let i = 0; i < N_EACH; i++) {
        await xaddRow("sensitivities:in", makeRow(c.rc, c.bkt, c.mk(i)));
      }
    }
    await processBatch(redis, {
      stream: "sensitivities:in", group: "ingest", consumerName: "ingest-bf", batchSize: 1000, schema: SCHEMA,
    }, ">");

    // Snapshot the consumer-built rollups so we can compare after the rebuild.
    const rollupKeys = await redis.keys("rollup:*");
    expect(rollupKeys.length).toBeGreaterThan(0);
    const expected = new Map<string, Record<string, string>>();
    for (const k of rollupKeys) expected.set(k, await redis.hgetall(k));

    // Drop every rollup then rebuild from the sens:* docs.
    for (const k of rollupKeys) await redis.del(k);
    expect((await redis.keys("rollup:*")).length).toBe(0);

    const report = await backfillRollups(redis as unknown as Parameters<typeof backfillRollups>[0]);
    expect(report.errors).toBe(0);
    expect(report.scanned).toBe(combos.length * N_EACH);
    expect(report.rollups_written).toBe(expected.size);

    const TOL_BF = 1e-9;
    for (const [k, want] of expected.entries()) {
      const got = await redis.hgetall(k);
      expect(Number(got.count)).toBe(Number(want.count));
      for (const f of ["sum_ws", "sum_ws_sq", "sum_ws_up", "sum_ws_up_sq", "sum_ws_down", "sum_ws_down_sq"] as const) {
        if (want[f] === undefined) continue;
        expect(Math.abs(Number(got[f]) - Number(want[f]))).toBeLessThanOrEqual(TOL_BF);
      }
    }

    // Re-running on the same corpus is a no-op (HSET overwrites with the
    // same values) — every HGETALL still matches the snapshot.
    const second = await backfillRollups(redis as unknown as Parameters<typeof backfillRollups>[0]);
    expect(second.errors).toBe(0);
    expect(second.rollups_written).toBe(expected.size);
    for (const [k, want] of expected.entries()) {
      const got = await redis.hgetall(k);
      expect(Number(got.count)).toBe(Number(want.count));
    }
  });
});

// Wave 6.24 — materialized discovery sets. Verifies emitSeenSadds emits the
// expected SADD triplet per applied row (no rollup HINCRBYFLOATs here — that
// path is exercised separately above). Uses the pipelineStub recorder so we
// can assert the exact command shape without booting Redis.
describe("emitSeenSadds — Wave 6.24", () => {
  it("emits SADD seen:risk_class + seen:bucket:{<rc>} + seen:sens_type:{<rc>:<bkt>} for a complete (rc, bkt, sens) row", () => {
    const record: RecordedPipelineCall[] = [];
    const stub = pipelineStub(record);
    emitSeenSadds(
      stub as unknown as { call: (cmd: string, ...args: unknown[]) => unknown },
      { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta" },
    );
    const sadds = record.filter((r) => r.command === "SADD");
    expect(sadds).toHaveLength(3);
    expect(sadds[0]).toEqual({ command: "SADD", args: [SEEN_RISK_CLASS_KEY, "GIRR"] });
    expect(sadds[1]).toEqual({ command: "SADD", args: [seenBucketKey("GIRR"), "USD-IRS"] });
    expect(sadds[2]).toEqual({
      command: "SADD",
      args: [seenSensTypeKey("GIRR", "USD-IRS"), "Delta"],
    });
  });

  it("hash-tags co-locate seen:bucket and seen:sens_type with the matching rollup hash key", () => {
    // The hash-tag of `rollup:{GIRR:USD-IRS}:Delta` is `GIRR:USD-IRS`, which
    // must match the tag inside `seen:sens_type:{GIRR:USD-IRS}` so both keys
    // land on the same Redis Cluster slot. `seen:bucket:{GIRR}` shares only
    // the `GIRR` prefix, intentionally — it indexes ALL buckets for the
    // risk class and lives on whichever slot owns `{GIRR}`.
    const rk = rollupKey("GIRR", "USD-IRS", "Delta");
    const sensTypeKey = seenSensTypeKey("GIRR", "USD-IRS");
    expect(rk).toContain("{GIRR:USD-IRS}");
    expect(sensTypeKey).toContain("{GIRR:USD-IRS}");
    const bucketKey = seenBucketKey("GIRR");
    expect(bucketKey).toContain("{GIRR}");
  });

  it("rows missing risk_class / bucket / sensitivity_type emit no SADDs", () => {
    const record: RecordedPipelineCall[] = [];
    const stub = pipelineStub(record);
    emitSeenSadds(
      stub as unknown as { call: (cmd: string, ...args: unknown[]) => unknown },
      { risk_class: "GIRR", bucket: "USD" }, // no sensitivity_type
    );
    expect(record.filter((r) => r.command === "SADD")).toHaveLength(0);
  });
});

// Wave 6.24 — end-to-end integration: a processBatch run against a live
// Redis Stack populates the three seen:* sets such that SMEMBERS reflects
// exactly the (rc, bkt, sens_type) tuples observed in the ingested fixture.
describe("processBatch seen:* SADD integration [Wave 6.24]", () => {
  integration("mixed 3-combo fixture → SMEMBERS reflects the ingested (rc, bkt, sens) tuples", async () => {
    await ensureGroup(redis, "sensitivities:in", "ingest");
    // Three distinct (rc, bkt, sens) combinations; multiple rows per combo
    // to verify SADD is idempotent (the SMEMBERS reply is deduped).
    const combos = [
      { rc: "GIRR", bkt: "USD-IRS", sens: "Delta" },
      { rc: "EQUITY", bkt: "1", sens: "Delta" },
      { rc: "FX", bkt: "EURUSD", sens: "Vega" },
    ];
    const ulid = monotonicFactory();
    for (const c of combos) {
      for (let i = 0; i < 3; i++) {
        await redis.xadd(
          "sensitivities:in", "*",
          "risk_class", c.rc,
          "bucket", c.bkt,
          "_hash_tag", `${c.rc}:${c.bkt}`,
          "_id", ulid(),
          "payload", JSON.stringify({
            sensitivity_type: c.sens,
            risk_value: c.sens === "Vega" ? { "1Y": 0.1 } : { spot: 0.1 },
          }),
        );
      }
    }
    await processBatch(redis, {
      stream: "sensitivities:in",
      group: "ingest",
      consumerName: "test",
      batchSize: 100,
      schema: SCHEMA,
    });
    // SMEMBERS of the three seen:* keys MUST equal the expected sets.
    const riskClasses = (await redis.smembers(SEEN_RISK_CLASS_KEY)).sort();
    expect(riskClasses).toEqual(["EQUITY", "FX", "GIRR"]);
    for (const c of combos) {
      const buckets = (await redis.smembers(seenBucketKey(c.rc))).sort();
      expect(buckets).toContain(c.bkt);
      const sensTypes = (await redis.smembers(seenSensTypeKey(c.rc, c.bkt))).sort();
      expect(sensTypes).toContain(c.sens);
    }
  });
});
