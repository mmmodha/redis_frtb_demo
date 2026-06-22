// Wave 6.39.C-fix — boot wiring for the Layer 4 cron jobs.
//
// Pins the post-listen contract: startL4Crons registers drift + snapshot +
// periodic XTRIM crons against the active Redis client, with a single
// DISABLE_L4_CRONS=1 kill switch for single-shot / SMOKE / boot-smoke runs.
// The cap consumed by the XTRIM tick matches computeMaxLen so /admin/stream-
// status reports the value that's actually enforced.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { startL4Crons } from "../src/jobs/start-l4-crons.ts";
import {
  __resetDriftResultsForTests,
  getDriftResults,
} from "../src/jobs/drift-detector.ts";
import {
  __resetMetricsForTests,
  getCounter,
} from "../src/jobs/metrics.ts";
import { computeMaxLen } from "../src/jobs/stream-retention.ts";

function primeFakeForCrons(fr: ReturnType<typeof fakeRedis>): void {
  // Drift detector reads: SRANDMEMBER seen:risk_class, SRANDMEMBER seen:bucket:<rc>,
  // then HGETALL rollup:<rc>:<bkt>:Delta (Wave 7.0.6.6 — tag-free).
  fr.setResponse("SRANDMEMBER", (args: unknown[]) => {
    const key = String(args[0]);
    if (key === "seen:risk_class") return "EQUITY";
    if (key === "seen:bucket:EQUITY") return "1";
    return null;
  });
  fr.setResponse("HGETALL", () => ["sum_ws", "1", "sum_ws_sq", "1", "count", "1"]);
  // Snapshot scans rollup:* keys then HMSET / EXPIRE / HSET them.
  fr.setScan("0", []);
  fr.setResponse("HMSET", () => "OK");
  fr.setResponse("EXPIRE", () => 1);
  fr.setResponse("HSET", () => 1);
  // XTRIM cap path.
  fr.setResponse("XTRIM", () => 0);
}

describe("startL4Crons", () => {
  beforeEach(() => {
    __resetDriftResultsForTests();
    __resetMetricsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers drift + snapshot + stream-trim crons and ticks each at the configured interval", async () => {
    vi.useFakeTimers();
    const fr = fakeRedis();
    primeFakeForCrons(fr);

    const handle = startL4Crons({
      redis: fr,
      env: {
        // Use sub-minute fake-timer intervals so the test exercises each tick
        // path without waiting on the 15/60-min production defaults. Math.max
        // inside startL4Crons floors fractional minutes to 1 ms, matching
        // the test-mode contract the task brief calls out.
        DRIFT_CHECK_INTERVAL_MIN: String(100 / 60_000),
        SNAPSHOT_INTERVAL_MIN: String(100 / 60_000),
        STREAM_TRIM_INTERVAL_MIN: String(100 / 60_000),
        // computeMaxLen-derived cap so the XTRIM call sees a positive arg.
        INGEST_PEAK_RATE_PER_SEC: "100",
      },
    });

    expect(handle.registered).toEqual({ drift: true, snapshot: true, streamTrim: true });

    // Advance one tick window and flush the queued micro-tasks so the
    // setInterval callbacks land + the async tick handlers settle.
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(150);

    expect(getCounter("drift_check_total")).toBeGreaterThan(0);
    expect(getCounter("snapshot_total")).toBeGreaterThan(0);
    const xtrimCalls = fr.calls.filter((c) => c.command === "XTRIM");
    expect(xtrimCalls.length).toBeGreaterThan(0);
    // Drift detector pushed a result for the seeded EQUITY:1 bucket.
    expect(getDriftResults().length).toBeGreaterThan(0);

    handle.stop();
  });

  it("DISABLE_L4_CRONS=1 skips registration entirely", async () => {
    vi.useFakeTimers();
    const fr = fakeRedis();
    primeFakeForCrons(fr);

    const handle = startL4Crons({
      redis: fr,
      env: { DISABLE_L4_CRONS: "1" },
    });

    expect(handle.registered).toEqual({ drift: false, snapshot: false, streamTrim: false });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(getCounter("drift_check_total")).toBe(0);
    expect(getCounter("snapshot_total")).toBe(0);
    expect(fr.calls.filter((c) => c.command === "XTRIM")).toHaveLength(0);

    handle.stop();
  });

  it("XTRIM tick uses computeMaxLen(peakRate) when INGEST_STREAM_MAXLEN is not set", async () => {
    vi.useFakeTimers();
    const fr = fakeRedis();
    primeFakeForCrons(fr);

    const handle = startL4Crons({
      redis: fr,
      env: {
        // Disable drift + snapshot so we isolate the XTRIM assertion.
        DRIFT_CHECK_INTERVAL_MIN: "1000",
        SNAPSHOT_INTERVAL_MIN: "1000",
        STREAM_TRIM_INTERVAL_MIN: String(100 / 60_000),
        INGEST_PEAK_RATE_PER_SEC: "100",
        STREAM_KEY: "sensitivities:in",
      },
    });
    await vi.advanceTimersByTimeAsync(150);

    const xtrim = fr.calls.find((c) => c.command === "XTRIM");
    expect(xtrim).toBeDefined();
    expect(xtrim!.args[0]).toBe("sensitivities:in");
    expect(xtrim!.args[1]).toBe("MAXLEN");
    expect(xtrim!.args[2]).toBe("~");
    expect(xtrim!.args[3]).toBe(String(computeMaxLen(100)));

    handle.stop();
  });

  it("XTRIM tick is skipped when neither INGEST_STREAM_MAXLEN nor INGEST_PEAK_RATE_PER_SEC is set", async () => {
    vi.useFakeTimers();
    const fr = fakeRedis();
    primeFakeForCrons(fr);

    const handle = startL4Crons({
      redis: fr,
      env: {
        DRIFT_CHECK_INTERVAL_MIN: "1000",
        SNAPSHOT_INTERVAL_MIN: "1000",
        STREAM_TRIM_INTERVAL_MIN: String(100 / 60_000),
      },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(fr.calls.filter((c) => c.command === "XTRIM")).toHaveLength(0);

    handle.stop();
  });
});
