// Wave 5.51 — live-refresh tests for <Observability />. Covers the
// cadence dropdown, polling loop, localStorage round-trip, and the
// "Updated Ns ago" badge. Wave 7.2 — mocks /observability/debug (single
// bundle fetch) instead of legacy /keys + /memory endpoints.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Observability, humanizeSeconds } from "../../src/routes/Observability";
import { OBS_REFRESH_STORAGE_KEY } from "../../src/hooks/useObservabilityRefresh";

type FetchMock = ReturnType<typeof vi.fn>;

const DEBUG_URL = /\/observability\/debug/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function debugPayload(dbsize = 42) {
  return {
    keys: { prefix: "sens:", dbsize, sample: [], sample_size: 0, ms: 1 },
    memory: { used_memory: 1024, used_memory_human: "1.00K", ms: 1 },
    index_count: { count: dbsize, refreshing: false, index_name: "idx:sens" },
    calc_recent: { items: [] },
    bootstrap: { phase: "ready", target_label: "local", err: null },
  };
}

function defaultHandler(url: string): Response {
  if (DEBUG_URL.test(url)) {
    return jsonResponse(debugPayload());
  }
  if (url.includes("/observability/history")) {
    return jsonResponse({
      source: "redis-timeseries",
      metric: "total_keys",
      windowMs: 18_000_000,
      points: [],
      reason: null,
      target_label: "local",
    });
  }
  if (url.includes("/ingest/snapshot")) {
    return jsonResponse({
      ok: true,
      target_label: "local",
      cluster: { sens_count: 42, sens_count_refreshing: false, memory_bytes: 1, memory_human: "1B" },
      loader: { in_flight: 0, flush_rps: 0, flushed_total: 0, throttled: false, recent_429_count: 0 },
      runs: [],
      focused_run_id: null,
    });
  }
  if (url.includes("/admin/stream-status")) {
    return jsonResponse({ xlen: 0, maxlen: 10000, peak_rate_per_sec: 0, consumed: 0 });
  }
  if (url.includes("/admin/drift-status")) {
    return jsonResponse({ threshold_pct: 0.01, results: [] });
  }
  if (url.includes("/generator/runs")) return jsonResponse({ active: [] });
  if (url.includes("/ingest/bulk/runs")) return jsonResponse({ active: [] });
  if (url.includes("/ingest/bulk/load-status")) return jsonResponse({ workers: [], dispatcher: { in_flight: 0 } });
  if (url.includes("/ingest/run-history")) return jsonResponse({ runs: [] });
  if (url.includes("/admin/calc-jobs")) return jsonResponse({ active: [] });
  if (url.includes("/admin/recent-errors")) return jsonResponse({ items: [] });
  return jsonResponse({}, 404);
}

function installFetchMock(handler: (url: string) => Response | Promise<Response> = defaultHandler): FetchMock {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as FetchMock;
}

function countObservabilityCalls(fn: FetchMock): number {
  let n = 0;
  for (const call of fn.mock.calls) {
    const arg = call[0];
    const url = typeof arg === "string" ? arg : String(arg);
    if (DEBUG_URL.test(url)) n++;
  }
  return n;
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/observability"]}>
      <Observability />
    </MemoryRouter>,
  );
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k: string) { map.delete(k); },
    setItem(k: string, v: string) { map.set(k, String(v)); },
  };
  return storage;
}

describe("<Observability /> live refresh", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults the cadence dropdown to 2s when localStorage is empty", async () => {
    installFetchMock();
    renderRoute();
    await flush(0);
    const select = screen.getByTestId("obs-refresh-select") as HTMLSelectElement;
    expect(select.value).toBe("2000");
  });

  it("reads the cadence from localStorage on mount", async () => {
    localStorage.setItem(OBS_REFRESH_STORAGE_KEY, "5000");
    installFetchMock();
    renderRoute();
    await flush(0);
    const select = screen.getByTestId("obs-refresh-select") as HTMLSelectElement;
    expect(select.value).toBe("5000");
  });

  it("falls back to 2s when localStorage holds an invalid value", async () => {
    localStorage.setItem(OBS_REFRESH_STORAGE_KEY, "1234");
    installFetchMock();
    renderRoute();
    await flush(0);
    const select = screen.getByTestId("obs-refresh-select") as HTMLSelectElement;
    expect(select.value).toBe("2000");
  });

  it("persists the cadence choice to localStorage", async () => {
    installFetchMock();
    renderRoute();
    await flush(0);
    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "5000" } });
    await flush(0);
    expect(localStorage.getItem(OBS_REFRESH_STORAGE_KEY)).toBe("5000");
  });

  it("selecting Off stops all subsequent fetches", async () => {
    const fetchMock = installFetchMock();
    renderRoute();
    await flush(0);
    const afterInitial = countObservabilityCalls(fetchMock);
    expect(afterInitial).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "0" } });
    await flush(0);
    const afterOff = countObservabilityCalls(fetchMock);

    await flush(15000);
    expect(countObservabilityCalls(fetchMock)).toBe(afterOff);
    expect(screen.getByTestId("obs-updated-badge").textContent).toBe("Updated 15s ago");
  });

  it("selecting 1s causes a fresh fetch every second", async () => {
    const fetchMock = installFetchMock();
    renderRoute();
    await flush(0);
    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "1000" } });
    await flush(0);
    const baseline = countObservabilityCalls(fetchMock);

    await flush(1000);
    const afterOne = countObservabilityCalls(fetchMock);
    expect(afterOne).toBeGreaterThan(baseline);

    await flush(1000);
    const afterTwo = countObservabilityCalls(fetchMock);
    expect(afterTwo).toBeGreaterThan(afterOne);
  });

  it("Wave 6.00 — with cadence on, the badge shows just the cadence label", async () => {
    installFetchMock();
    renderRoute();
    await flush(0);
    const badge = screen.getByTestId("obs-updated-badge");
    expect(badge.textContent).toBe("2s");

    await flush(1000);
    expect(badge.textContent).toBe("2s");

    await flush(1000);
    expect(badge.textContent).toBe("2s");
  });

  it("Wave 6.00 — with cadence Off, the badge humanizes time-since-fetch", async () => {
    installFetchMock();
    renderRoute();
    await flush(0);
    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "0" } });
    await flush(0);
    const badge = screen.getByTestId("obs-updated-badge");
    expect(badge.textContent).toBe("Updated 0s ago");

    await flush(12_000);
    expect(badge.textContent).toBe("Updated 12s ago");

    await flush(78_000);
    expect(badge.textContent).toBe("Updated 1m ago");
  });

  it("Wave 6.00 — manual refresh button fires a fetch and bumps the pulse key", async () => {
    const fetchMock = installFetchMock();
    renderRoute();
    await flush(0);
    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "0" } });
    await flush(0);

    const badge = screen.getByTestId("obs-updated-badge");
    const beforeKey = badge.getAttribute("data-pulse-key");
    const beforeCount = countObservabilityCalls(fetchMock);

    const button = screen.getByTestId("obs-manual-refresh") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await flush(0);

    expect(countObservabilityCalls(fetchMock)).toBeGreaterThan(beforeCount);
    const afterKey = badge.getAttribute("data-pulse-key");
    expect(afterKey).not.toBe(beforeKey);
    expect(button.disabled).toBe(false);
  });

  it("Wave 6.03 — manual refresh button is hidden when auto-refresh is on", async () => {
    installFetchMock();
    renderRoute();
    await flush(0);
    expect(screen.queryByTestId("obs-manual-refresh")).toBeNull();

    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "0" } });
    await flush(0);
    expect(screen.queryByTestId("obs-manual-refresh")).not.toBeNull();

    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "2000" } });
    await flush(0);
    expect(screen.queryByTestId("obs-manual-refresh")).toBeNull();
  });

  it("keeps last data and shows an inline error pill when a later fetch fails", async () => {
    vi.useRealTimers();
    let mode: "ok" | "fail" = "ok";
    installFetchMock((url) => {
      if (mode === "fail") return Promise.reject(new Error("boom"));
      return defaultHandler(url);
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("obs-sens-tile")).toHaveTextContent("42");
    });
    expect(screen.queryByTestId("obs-refresh-error")).toBeNull();

    mode = "fail";
    await waitFor(
      () => expect(screen.getByTestId("obs-refresh-error")).toBeInTheDocument(),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId("obs-sens-tile")).toHaveTextContent("42");
  });
});

describe("humanizeSeconds", () => {
  it("renders sub-minute values as seconds", () => {
    expect(humanizeSeconds(0)).toBe("0s");
    expect(humanizeSeconds(12)).toBe("12s");
    expect(humanizeSeconds(59)).toBe("59s");
  });

  it("crosses to minutes at 60s and floors", () => {
    expect(humanizeSeconds(60)).toBe("1m");
    expect(humanizeSeconds(90)).toBe("1m");
    expect(humanizeSeconds(60 * 59)).toBe("59m");
  });

  it("crosses to hours at 60m and floors", () => {
    expect(humanizeSeconds(60 * 60)).toBe("1h");
    expect(humanizeSeconds(60 * 70)).toBe("1h");
    expect(humanizeSeconds(60 * 60 * 23)).toBe("23h");
  });

  it("crosses to days at 24h and floors", () => {
    expect(humanizeSeconds(60 * 60 * 24)).toBe("1d");
    expect(humanizeSeconds(60 * 60 * 26)).toBe("1d");
    expect(humanizeSeconds(60 * 60 * 24 * 3)).toBe("3d");
  });
});
