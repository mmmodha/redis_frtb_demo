import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import {
  useIngestClusterStats,
  INGEST_CLUSTER_IDLE_REFRESH_MS,
  INGEST_CLUSTER_ACTIVE_REFRESH_MS,
  INGEST_CLUSTER_BURST_MS,
} from "../../src/hooks/useIngestClusterStats";

describe("useIngestClusterStats", () => {
  let liveDbSize = 1000;
  let indexCountCalls = 0;
  let observabilityCalls = 0;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    liveDbSize = 1000;
    indexCountCalls = 0;
    observabilityCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/observability/memory")) {
        return {
          ok: true,
          json: async () => ({
            used_memory: 1_000_000,
            used_memory_human: "1M",
            maxmemory_bytes: 8_000_000,
          }),
        };
      }
      if (url.includes("/observability/keys")) {
        observabilityCalls += 1;
        liveDbSize += observabilityCalls > 1 ? 500 : 0;
        return {
          ok: true,
          json: async () => ({
            prefix: "sens:",
            dbsize: liveDbSize,
            sample: [],
            sample_size: 0,
            ms: 1,
          }),
        };
      }
      if (url.includes("/admin/index-count")) {
        indexCountCalls += 1;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            count: 900,
            index_name: "dbsize",
            refreshing: false,
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls cached index-count on the idle 60s cadence", async () => {
    const { result } = renderHook(() => useIngestClusterStats());
    await waitFor(() => expect(result.current.sens.count).toBe(900));
    expect(observabilityCalls).toBe(0);
    expect(indexCountCalls).toBe(1);

    act(() => { vi.advanceTimersByTime(INGEST_CLUSTER_IDLE_REFRESH_MS); });
    await waitFor(() => expect(indexCountCalls).toBe(2));
    expect(observabilityCalls).toBe(0);
  });

  it("polls live observability keys every 1s while liveKeys", async () => {
    const { result } = renderHook(() => useIngestClusterStats({ liveKeys: true }));
    await waitFor(() => expect(result.current.sens.count).toBe(1000));
    expect(observabilityCalls).toBeGreaterThanOrEqual(1);
    expect(indexCountCalls).toBe(0);

    act(() => { vi.advanceTimersByTime(INGEST_CLUSTER_ACTIVE_REFRESH_MS); });
    await waitFor(() => expect(result.current.sens.count).toBe(1500));
    expect(observabilityCalls).toBeGreaterThanOrEqual(2);
  });

  it("keeps live polling for the burst window after liveKeys ends", async () => {
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useIngestClusterStats({ liveKeys: live }),
      { initialProps: { live: true } },
    );
    await waitFor(() => expect(result.current.sens.count).toBe(1000));
    const liveCalls = observabilityCalls;

    rerender({ live: false });
    act(() => { vi.advanceTimersByTime(INGEST_CLUSTER_ACTIVE_REFRESH_MS); });
    await waitFor(() => expect(observabilityCalls).toBeGreaterThan(liveCalls));

    act(() => { vi.advanceTimersByTime(INGEST_CLUSTER_BURST_MS); });
    act(() => { vi.advanceTimersByTime(INGEST_CLUSTER_IDLE_REFRESH_MS); });
    await waitFor(() => expect(indexCountCalls).toBeGreaterThan(0));
  });

  it("uses live DBSIZE while a persisted run baseline is set", async () => {
    const { result } = renderHook(() => useIngestClusterStats({ persistedKeysAtRunStart: 500 }));
    await waitFor(() => expect(result.current.sens.count).toBe(1000));
    expect(observabilityCalls).toBeGreaterThanOrEqual(1);
    expect(indexCountCalls).toBe(0);
  });
});
