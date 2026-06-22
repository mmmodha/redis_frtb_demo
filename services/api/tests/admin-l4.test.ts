// Wave 6.39.C — Layer 4 admin endpoints (drift-status, snapshots,
// reconcile-bucket, stream-status, /metrics). Exercised against a Fastify
// instance built from `registerAdminL4Routes` directly so each test stays
// independent of the broader createServer() wiring.

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { rollupKey } from "@frtb/calc-shared/rollup-keys";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { registerAdminL4Routes } from "../src/routes/admin-l4.ts";
import { __resetDriftResultsForTests, runDriftCheck } from "../src/jobs/drift-detector.ts";
import { __resetMetricsForTests, incCounter } from "../src/jobs/metrics.ts";

function buildApp(fr: ReturnType<typeof fakeRedis>, opts: { adminToken?: string; streamConfig?: { streamKey: string; maxLen: number; peakRatePerSec: number } } = {}): ReturnType<typeof Fastify> {
  const app = Fastify();
  registerAdminL4Routes(app, () => fr, {
    adminToken: opts.adminToken ?? "secret-token",
    streamConfig: opts.streamConfig ?? {
      streamKey: "sensitivities:in",
      maxLen: 1_000_000,
      peakRatePerSec: 100,
    },
    // Stubbed recompute so the unit suite stays decoupled from
    // aggregate-via-index. Production wires the real FT.AGGREGATE bridge.
    recomputeBucketSum: async () => 0,
  });
  return app;
}

beforeEach(() => {
  __resetDriftResultsForTests();
  __resetMetricsForTests();
});

describe("GET /admin/drift-status", () => {
  it("returns the last drift-check results from the ring buffer", async () => {
    const fr = fakeRedis();
    fr.setResponse("SRANDMEMBER", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return "EQUITY";
      if (key === "seen:bucket:EQUITY") return "1";
      return null;
    });
    fr.setResponse("HGETALL", () => ["sum_ws", "10", "count", "1"]);
    await runDriftCheck({ redis: fr, sensitivityType: "Delta", recomputeSum: async () => 10 });
    const app = buildApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/drift-status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ bucket: "EQUITY:1", status: "ok" });
    expect(body.threshold_pct).toBeGreaterThan(0);
    await app.close();
  });
});

describe("GET /admin/snapshots", () => {
  it("lists prior snapshot runs from snap:index", async () => {
    const fr = fakeRedis();
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "snap:index") return ["2026-06-18T12:00:00.000Z", "7"];
      return [];
    });
    const app = buildApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/snapshots" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]).toMatchObject({ ts: "2026-06-18T12:00:00.000Z", key_count: 7 });
    await app.close();
  });
});

describe("GET /admin/stream-status", () => {
  it("returns the configured retention numbers", async () => {
    const fr = fakeRedis();
    fr.setResponse("XLEN", () => 5_000_000);
    const app = buildApp(fr);
    const res = await app.inject({ method: "GET", url: "/admin/stream-status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stream_key).toBe("sensitivities:in");
    expect(body.xlen).toBe(5_000_000);
    expect(body.maxlen).toBe(1_000_000);
    expect(body.peak_rate_per_sec).toBe(100);
    await app.close();
  });
});

describe("POST /admin/reconcile-bucket", () => {
  it("returns 401 without a valid X-Admin-Token header", async () => {
    const fr = fakeRedis();
    const app = buildApp(fr);
    const res = await app.inject({
      method: "POST",
      url: "/admin/reconcile-bucket",
      payload: { risk_class: "EQUITY", bucket: "1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 on a mismatched token", async () => {
    const fr = fakeRedis();
    const app = buildApp(fr);
    const res = await app.inject({
      method: "POST",
      url: "/admin/reconcile-bucket",
      headers: { "x-admin-token": "wrong" },
      payload: { risk_class: "EQUITY", bucket: "1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("recomputes + atomically overwrites rollup with valid token", async () => {
    const fr = fakeRedis();
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === rollupKey("EQUITY", "1", "Delta")) {
        return ["sum_ws", "55", "sum_ws_sq", "0", "count", "3"];
      }
      return [];
    });
    fr.setResponse("DEL", () => 1);
    fr.setResponse("HMSET", () => "OK");
    const app = Fastify();
    registerAdminL4Routes(app, () => fr, {
      adminToken: "secret-token",
      streamConfig: { streamKey: "sensitivities:in", maxLen: 0, peakRatePerSec: 0 },
      recomputeBucketSum: async () => 99,
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/reconcile-bucket",
      headers: { "x-admin-token": "secret-token" },
      payload: { risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.before_sum).toBe(55);
    expect(body.after_sum).toBe(99);
    expect(body.drift_pct).toBeCloseTo((Math.abs(55 - 99) / 55) * 100, 4);

    // MULTI/EXEC-style atomic overwrite via the pipeline. Both DEL and HMSET
    // land on the same rollup key.
    const delCalls = fr.calls.filter((c) => c.command === "DEL");
    const hmsetCalls = fr.calls.filter((c) => c.command === "HMSET");
    expect(delCalls).toHaveLength(1);
    expect(hmsetCalls).toHaveLength(1);
    expect(delCalls[0]!.args[0]).toBe(rollupKey("EQUITY", "1", "Delta"));
    expect(hmsetCalls[0]!.args[0]).toBe(rollupKey("EQUITY", "1", "Delta"));
    await app.close();
  });
});

describe("GET /metrics (via admin-calc /metrics handler)", () => {
  it("renders the three Layer 4 counters alongside kb_cache counters", async () => {
    incCounter("drift_check_total", 3);
    incCounter("snapshot_total", 2);
    incCounter("reconcile_total", 1);
    const fr = fakeRedis();
    const { registerAdminCalcRoutes } = await import("../src/routes/admin-calc.ts");
    const app = Fastify();
    registerAdminCalcRoutes(app, () => fr);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    const body = res.body;
    expect(body).toMatch(/# HELP drift_check_total/);
    expect(body).toMatch(/# TYPE drift_check_total counter/);
    expect(body).toMatch(/drift_check_total 3/);
    expect(body).toMatch(/snapshot_total 2/);
    expect(body).toMatch(/reconcile_total 1/);
    expect(body).toMatch(/kb_cache_hit_total/);
    await app.close();
  });
});
