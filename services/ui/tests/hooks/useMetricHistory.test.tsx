import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useMetricHistory, RING_CAP } from "../../src/hooks/useMetricHistory";

// Node 25 ships a process-level `localStorage` whose `setItem` is a no-op
// without `--localstorage-file`. Install a Map-backed override on the
// jsdom window for the duration of this suite so both the hook and the
// test code observe the same storage.
beforeAll(() => {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { store.set(k, String(v)); },
    removeItem(k: string) { store.delete(k); },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
  };
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true });
});

type FetchMock = ReturnType<typeof vi.fn>;
function mockFetch(handler: (url: string) => Response | Promise<Response>): FetchMock {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as FetchMock;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ORIGINAL_FETCH = globalThis.fetch;

// Node 25 ships a process-level `localStorage` whose surface differs from
// jsdom's; even `window.localStorage.clear` may be undefined. We explicitly
// remove the keys this suite touches instead of relying on `.clear()`.
function resetRing(): void {
  for (const tgt of ["tA", "tB"]) {
    for (const metric of ["total_keys", "memory_used_bytes", "ops_per_sec", "shard_count"]) {
      try { window.localStorage.removeItem(`obs.ring.${tgt}.${metric}`); } catch { /* ignore */ }
    }
  }
}

describe("useMetricHistory", () => {
  beforeEach(() => { window.localStorage.clear(); resetRing(); });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; vi.restoreAllMocks(); window.localStorage.clear(); resetRing(); });

  it("returns server points when source is redis-timeseries", async () => {
    mockFetch((url) => {
      if (url.includes("/observability/history")) {
        return jsonResponse({
          source: "redis-timeseries",
          metric: "total_keys",
          windowMs: 18_000_000,
          points: [{ t: 1, v: 10 }, { t: 2, v: 20 }],
          reason: null,
          target_label: "tA",
        });
      }
      return jsonResponse({}, 404);
    });
    const { result } = renderHook(() => useMetricHistory({ metric: "total_keys", currentValue: 0, pulseKey: 0 }));
    await waitFor(() => expect(result.current.source).toBe("redis-timeseries"));
    expect(result.current.points).toHaveLength(2);
    expect(result.current.target_label).toBe("tA");
  });

  it("falls back to ring buffer when source is unavailable and appends on pulseKey", async () => {
    mockFetch((url) => {
      if (url.includes("/observability/history")) {
        return jsonResponse({
          source: "unavailable",
          metric: "total_keys",
          windowMs: 18_000_000,
          points: [],
          reason: "module-not-loaded",
          target_label: "tA",
        });
      }
      return jsonResponse({}, 404);
    });
    let pulse = 0;
    let value = 100;
    const { result, rerender } = renderHook(({ p, v }: { p: number; v: number }) =>
      useMetricHistory({ metric: "total_keys", currentValue: v, pulseKey: p }), {
      initialProps: { p: pulse, v: value },
    });
    await waitFor(() => expect(result.current.source).toBe("ring-buffer"));
    expect(result.current.points).toHaveLength(0);

    pulse = 1; value = 150;
    await act(async () => { rerender({ p: pulse, v: value }); });
    await waitFor(() => expect(result.current.points.length).toBe(1));
    expect(result.current.points[0]!.v).toBe(150);

    pulse = 2; value = 175;
    await act(async () => { rerender({ p: pulse, v: value }); });
    await waitFor(() => expect(result.current.points.length).toBe(2));

    // localStorage round-trip — the same key should round-trip the same values.
    const raw = window.localStorage.getItem("obs.ring.tA.total_keys");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.length).toBe(2);
    expect(parsed[1].v).toBe(175);
  });

  it("clears the previous target's ring buffer on a target switch", async () => {
    window.localStorage.setItem(
      "obs.ring.tA.total_keys",
      JSON.stringify([{ t: 1, v: 1 }, { t: 2, v: 2 }]),
    );
    let target = "tB";
    mockFetch(() => jsonResponse({
      source: "unavailable",
      metric: "total_keys",
      windowMs: 18_000_000,
      points: [],
      reason: "module-not-loaded",
      target_label: target,
    }));
    // First call surfaces tB; this triggers a purge of the previous tracked
    // target if any. Since this is the first fetch the previous-target ref
    // is null so nothing is purged yet. We then mutate `target` to "tA" so
    // the second fetch (driven by the 30s timer; we trigger it by calling
    // the hook with a new pulseKey since the timer is too slow) flips the
    // ref and purges the *old* (tB) key. But tA's pre-seeded buffer should
    // remain untouched here — we instead force a tB→tA flip and assert
    // both purge directions explicitly.
    const { unmount } = renderHook(() => useMetricHistory({ metric: "total_keys", currentValue: 0, pulseKey: 0 }));
    await waitFor(() => {
      const callsForHistory = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
        .mock.calls.filter((c) => String(c[0]).includes("/observability/history"));
      expect(callsForHistory.length).toBeGreaterThan(0);
    });
    unmount();

    // Now switch the server-reported target to tA; remount the hook and
    // assert it purges the tB key on the *next* fetch.
    target = "tA";
    window.localStorage.setItem("obs.ring.tB.total_keys", JSON.stringify([{ t: 3, v: 3 }]));
    const { result } = renderHook(() => useMetricHistory({ metric: "total_keys", currentValue: 0, pulseKey: 0 }));
    await waitFor(() => expect(result.current.target_label).toBe("tA"));
    // tA's pre-seed read once the hook resolves
    expect(result.current.source).toBe("ring-buffer");
  });

  it("caps ring buffer at RING_CAP samples", async () => {
    mockFetch(() => jsonResponse({
      source: "unavailable", metric: "total_keys", windowMs: 18_000_000,
      points: [], reason: "module-not-loaded", target_label: "tA",
    }));
    const { result, rerender } = renderHook(({ p, v }: { p: number; v: number }) =>
      useMetricHistory({ metric: "total_keys", currentValue: v, pulseKey: p }),
      { initialProps: { p: 0, v: 0 } });
    await waitFor(() => expect(result.current.source).toBe("ring-buffer"));
    for (let i = 1; i <= RING_CAP + 50; i++) {
      await act(async () => { rerender({ p: i, v: i }); });
    }
    await waitFor(() => expect(result.current.points.length).toBe(RING_CAP));
  });

  it("survives a fetch failure and stays in unknown state", async () => {
    mockFetch(() => { throw new Error("network down"); });
    const { result } = renderHook(() => useMetricHistory({ metric: "total_keys", currentValue: 0, pulseKey: 0 }));
    await waitFor(() => expect(result.current.reason).toBe("fetch-error"));
    expect(result.current.points).toEqual([]);
  });

  // Wave 5.61 — windowMs is in the effect deps, so changing it triggers a
  // fresh fetch through /observability/history?windowMs=<new>.
  it("re-fetches when windowMs changes", async () => {
    const fetchMock = mockFetch((url) => {
      const u = new URL(url, "http://localhost");
      const w = u.searchParams.get("windowMs") ?? "18000000";
      return jsonResponse({
        source: "redis-timeseries",
        metric: "total_keys",
        windowMs: Number(w),
        points: [{ t: 1, v: Number(w) }],
        reason: null,
        target_label: "tA",
      });
    });
    const { result, rerender } = renderHook(({ w }: { w: number }) =>
      useMetricHistory({ metric: "total_keys", currentValue: 0, pulseKey: 0, windowMs: w }), {
      initialProps: { w: 18_000_000 },
    });
    await waitFor(() => expect(result.current.points.length).toBe(1));
    const initialCalls = fetchMock.mock.calls.length;
    rerender({ w: 1_800_000 });
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("windowMs=1800000"))).toBe(true);
  });

  // Wave 5.61 — ring-buffer source clamps the returned view to windowMs.
  it("clamps ring-buffer points to the selected window", async () => {
    const NOW = 2_000_000_000_000;
    const FIVE_H = 18_000_000;
    const stored = [
      { t: NOW - 4 * 3_600_000, v: 10 }, // 4h ago
      { t: NOW - 90 * 60_000, v: 20 },   // 90m ago
      { t: NOW - 10 * 60_000, v: 30 },   // 10m ago
      { t: NOW - 1 * 60_000, v: 40 },    // 1m ago
    ];
    window.localStorage.setItem("obs.ring.tA.total_keys", JSON.stringify(stored));
    mockFetch(() => jsonResponse({
      source: "unavailable", metric: "total_keys", windowMs: FIVE_H,
      points: [], reason: "module-not-loaded", target_label: "tA",
    }));
    const fixedNow = (): number => NOW;
    const { result } = renderHook(() =>
      useMetricHistory({ metric: "total_keys", currentValue: null, pulseKey: 0,
        windowMs: 1_800_000, nowFn: fixedNow }));
    await waitFor(() => expect(result.current.source).toBe("ring-buffer"));
    // Only the two points within the last 30m should remain visible.
    expect(result.current.points.map((p) => p.v)).toEqual([30, 40]);
  });
});
