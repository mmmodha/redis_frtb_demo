// Wave 6.39.C — Layer 4: ingest stream retention.
//
// `computeMaxLen(peakRatePerSec)` derives the approximate XADD MAXLEN cap
// from the empirical peak ingest rate so 48 h of writes survive at peak.
// `readStreamStatus(redis, streamKey)` returns the current XLEN, the cap,
// and the estimated hours of retention available right now (`xlen / peak`).

import { describe, it, expect } from "vitest";
import { fakeRedis } from "./helpers/fake-redis.ts";
import {
  computeMaxLen,
  readStreamStatus,
  DEFAULT_RETENTION_HOURS,
  DEFAULT_SAFETY_FACTOR,
} from "../src/jobs/stream-retention.ts";

describe("computeMaxLen", () => {
  it("uses 48h × peak × 2× safety factor by default", () => {
    expect(computeMaxLen(100)).toBe(100 * 3600 * DEFAULT_RETENTION_HOURS * DEFAULT_SAFETY_FACTOR);
  });
  it("honours an override safety factor", () => {
    expect(computeMaxLen(50, { safetyFactor: 1, retentionHours: 1 })).toBe(180_000);
  });
  it("floors fractional rates to a whole number", () => {
    const v = computeMaxLen(0.5, { safetyFactor: 1, retentionHours: 1 });
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBe(1800);
  });
  it("returns 0 when peak rate is 0", () => {
    expect(computeMaxLen(0)).toBe(0);
  });
});

describe("readStreamStatus", () => {
  it("returns XLEN, configured maxlen, and retention hours", async () => {
    const fr = fakeRedis();
    fr.setResponse("XLEN", () => 1_000_000);
    const status = await readStreamStatus(fr, {
      streamKey: "sensitivities:in",
      maxLen: 5_000_000,
      peakRatePerSec: 100,
    });
    expect(status.stream_key).toBe("sensitivities:in");
    expect(status.xlen).toBe(1_000_000);
    expect(status.maxlen).toBe(5_000_000);
    expect(status.peak_rate_per_sec).toBe(100);
    // 1_000_000 entries / 100 per sec / 3600 = ~2.78 h.
    expect(status.retention_hours_now).toBeCloseTo(1_000_000 / 100 / 3600, 2);
  });

  it("returns retention_hours_now = 0 when peak rate is 0", async () => {
    const fr = fakeRedis();
    fr.setResponse("XLEN", () => 42);
    const status = await readStreamStatus(fr, {
      streamKey: "sensitivities:in",
      maxLen: 0,
      peakRatePerSec: 0,
    });
    expect(status.retention_hours_now).toBe(0);
    expect(status.xlen).toBe(42);
  });

  it("returns xlen=0 when XLEN call throws (stream missing)", async () => {
    const fr = fakeRedis();
    fr.setResponse("XLEN", () => {
      throw new Error("ERR no such key");
    });
    const status = await readStreamStatus(fr, {
      streamKey: "sensitivities:in",
      maxLen: 100,
      peakRatePerSec: 10,
    });
    expect(status.xlen).toBe(0);
  });
});
