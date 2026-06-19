// Wave 6.39.C — Layer 4: rollup drift detector.
//
// Picks a random (rc, bucket) from the seen:* discovery sets, recomputes the
// `sum_ws` for the bucket via an injectable `recomputeSum` (production wires
// this to FT.AGGREGATE; tests stub it), compares to the value persisted in
// the `rollup:{rc:bkt}:Delta` hash, and records the result in a bounded ring
// buffer for /admin/drift-status. Increments `drift_check_total` per tick.

import { describe, it, expect, beforeEach } from "vitest";
import { fakeRedis } from "./helpers/fake-redis.ts";
import {
  runDriftCheck,
  __resetDriftResultsForTests,
  getDriftResults,
  clearDriftResults,
} from "../src/jobs/drift-detector.ts";
import { __resetMetricsForTests, getCounter } from "../src/jobs/metrics.ts";

describe("runDriftCheck", () => {
  beforeEach(() => {
    __resetDriftResultsForTests();
    __resetMetricsForTests();
  });

  it("reports drift_pct = 0 when rollup matches recomputed sum_ws", async () => {
    const fr = fakeRedis();
    fr.setResponse("SRANDMEMBER", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return "EQUITY";
      if (key === "seen:bucket:{EQUITY}") return "1";
      return null;
    });
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "rollup:{EQUITY:1}:Delta") {
        return ["sum_ws", "1234.5", "sum_ws_sq", "999", "count", "10"];
      }
      return [];
    });
    const result = await runDriftCheck({
      redis: fr,
      sensitivityType: "Delta",
      recomputeSum: async () => 1234.5,
    });
    expect(result).not.toBeNull();
    expect(result!.bucket).toBe("EQUITY:1");
    expect(result!.rollup_sum).toBeCloseTo(1234.5);
    expect(result!.recomputed_sum).toBeCloseTo(1234.5);
    expect(result!.drift_pct).toBe(0);
    expect(result!.status).toBe("ok");
    expect(getCounter("drift_check_total")).toBe(1);
  });

  it("reports drift_pct > threshold when rollup is stale", async () => {
    const fr = fakeRedis();
    fr.setResponse("SRANDMEMBER", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return "GIRR";
      if (key === "seen:bucket:{GIRR}") return "USD";
      return null;
    });
    fr.setResponse("HGETALL", () => ["sum_ws", "100", "count", "5"]);
    const result = await runDriftCheck({
      redis: fr,
      sensitivityType: "Delta",
      thresholdPct: 0.01,
      recomputeSum: async () => 101,
    });
    expect(result).not.toBeNull();
    expect(result!.drift_pct).toBeGreaterThan(0.01);
    expect(result!.status).toBe("drift");
  });

  it("returns null when seen:risk_class is empty", async () => {
    const fr = fakeRedis();
    fr.setResponse("SRANDMEMBER", () => null);
    const result = await runDriftCheck({
      redis: fr,
      sensitivityType: "Delta",
      recomputeSum: async () => 0,
    });
    expect(result).toBeNull();
    expect(getCounter("drift_check_total")).toBe(1);
  });

  it("appends to the drift-results ring buffer (max 100)", async () => {
    const fr = fakeRedis();
    fr.setResponse("SRANDMEMBER", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return "EQUITY";
      if (key === "seen:bucket:{EQUITY}") return "1";
      return null;
    });
    fr.setResponse("HGETALL", () => ["sum_ws", "10", "count", "1"]);
    for (let i = 0; i < 105; i++) {
      await runDriftCheck({
        redis: fr,
        sensitivityType: "Delta",
        recomputeSum: async () => 10,
      });
    }
    const results = getDriftResults();
    expect(results).toHaveLength(100);
    expect(getCounter("drift_check_total")).toBe(105);
  });

  // Wave 6.39.I — production-callable clear wired into the active-target
  // change listener. Entries collected against the prior target must not
  // surface on /admin/drift-status after a profile switch (their rc:bucket
  // refers to data that doesn't exist on the new target).
  it("clearDriftResults empties the ring buffer after entries accumulate", async () => {
    const fr = fakeRedis();
    fr.setResponse("SRANDMEMBER", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return "EQUITY";
      if (key === "seen:bucket:{EQUITY}") return "1";
      return null;
    });
    fr.setResponse("HGETALL", () => ["sum_ws", "10", "count", "1"]);
    await runDriftCheck({ redis: fr, sensitivityType: "Delta", recomputeSum: async () => 10 });
    await runDriftCheck({ redis: fr, sensitivityType: "Delta", recomputeSum: async () => 10 });
    expect(getDriftResults()).toHaveLength(2);

    clearDriftResults();
    expect(getDriftResults()).toHaveLength(0);
  });

  it("treats zero rollup_sum and zero recomputed_sum as drift_pct = 0", async () => {
    const fr = fakeRedis();
    fr.setResponse("SRANDMEMBER", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return "FX";
      if (key === "seen:bucket:{FX}") return "EURUSD";
      return null;
    });
    fr.setResponse("HGETALL", () => ["sum_ws", "0", "count", "0"]);
    const result = await runDriftCheck({
      redis: fr,
      sensitivityType: "Delta",
      recomputeSum: async () => 0,
    });
    expect(result!.drift_pct).toBe(0);
    expect(result!.status).toBe("ok");
  });
});
