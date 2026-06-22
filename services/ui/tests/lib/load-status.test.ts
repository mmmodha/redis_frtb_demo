// Wave 7.0.6.21 — typed wrapper around /load/status used by the IngestPanel
// RateGauge. Exercises the normalization + graceful-default branches so a
// missing or malformed payload never crashes the panel.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeLoadStatus,
  getLoadStatusSummary,
  LOAD_STATUS_GRACEFUL_DEFAULT,
} from "../../src/lib/load-status";

describe("normalizeLoadStatus", () => {
  it("extracts in_flight + high_water from the dispatcher branch", () => {
    const out = normalizeLoadStatus({
      dispatcher: { in_flight: 7600, high_water: 8000 },
      throttled: true,
      headroom_pct: 0.05,
      recent_429_count: 12,
    });
    expect(out).toEqual({
      in_flight: 7600,
      high_water: 8000,
      throttled: true,
      headroom_pct: 0.05,
      recent_429_count: 12,
    });
  });

  it("degrades to safe defaults when dispatcher is null (bulk-loader pre-6.22)", () => {
    const out = normalizeLoadStatus({ dispatcher: null, throttled: false });
    expect(out.in_flight).toBe(0);
    expect(out.high_water).toBe(0);
    expect(out.throttled).toBe(false);
    expect(out.headroom_pct).toBe(1);
    expect(out.recent_429_count).toBe(0);
  });

  it("returns the graceful-default snapshot for non-object inputs", () => {
    expect(normalizeLoadStatus(null)).toEqual(LOAD_STATUS_GRACEFUL_DEFAULT);
    expect(normalizeLoadStatus(undefined)).toEqual(LOAD_STATUS_GRACEFUL_DEFAULT);
    expect(normalizeLoadStatus("not-json")).toEqual(LOAD_STATUS_GRACEFUL_DEFAULT);
  });

  it("clamps recent_429_count to a non-negative integer", () => {
    expect(normalizeLoadStatus({ recent_429_count: -5 }).recent_429_count).toBe(0);
    expect(normalizeLoadStatus({ recent_429_count: 7.9 }).recent_429_count).toBe(7);
  });
});

describe("getLoadStatusSummary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the normalized snapshot on 200", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        dispatcher: { in_flight: 100, high_water: 8000 },
        throttled: false,
        headroom_pct: 0.987,
        recent_429_count: 0,
      }),
    });
    const out = await getLoadStatusSummary();
    expect(out.in_flight).toBe(100);
    expect(out.high_water).toBe(8000);
    expect(out.throttled).toBe(false);
  });

  it("degrades gracefully on non-2xx", async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    const out = await getLoadStatusSummary();
    expect(out).toEqual(LOAD_STATUS_GRACEFUL_DEFAULT);
  });

  it("degrades gracefully when fetch throws", async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error("bulk-loader unreachable"));
    const out = await getLoadStatusSummary();
    expect(out).toEqual(LOAD_STATUS_GRACEFUL_DEFAULT);
  });
});
