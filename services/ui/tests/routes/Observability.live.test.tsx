// Wave 5.51 — live-refresh tests for <Observability />. Covers the
// cadence dropdown, polling loop, localStorage round-trip, the
// "Updated Ns ago" badge, and shard prop passthrough.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Observability, humanizeSeconds } from "../../src/routes/Observability";
import { OBS_REFRESH_STORAGE_KEY } from "../../src/hooks/useObservabilityRefresh";

type FetchMock = ReturnType<typeof vi.fn>;

const KEYS_URL = /\/observability\/keys/;
const MEMORY_URL = /\/observability\/memory/;
const SHARDS_URL = /\/observability\/shards$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function defaultHandler(url: string): Response {
  if (KEYS_URL.test(url)) {
    return jsonResponse({ prefix: "sens:", dbsize: 42, sample: [], sample_size: 0, ms: 1 });
  }
  if (MEMORY_URL.test(url)) {
    return jsonResponse({ used_memory: 1024, used_memory_human: "1.00K", ms: 1 });
  }
  if (SHARDS_URL.test(url)) {
    return jsonResponse([
      { shardId: "shard-alpha", role: "master", opsPerSec: 100, slotCount: 8192, usedMemoryBytes: 1024, netInBytes: 0, netOutBytes: 0 },
      { shardId: "shard-beta",  role: "master", opsPerSec: 200, slotCount: 8192, usedMemoryBytes: 2048, netInBytes: 0, netOutBytes: 0 },
    ]);
  }
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
    if (KEYS_URL.test(url) || MEMORY_URL.test(url) || SHARDS_URL.test(url)) n++;
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

// Flush microtasks and any timers due at `ms` so fetch promises resolve and
// state updates flush under fake timers.
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Node 22's experimental globalThis.localStorage can shadow the jsdom one and
// strip out the standard API; build a small in-memory Storage shim per test so
// the hook's readStored/writeStored helpers behave normally.
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

    // Advance well beyond every supported cadence — no further calls.
    await flush(15000);
    expect(countObservabilityCalls(fetchMock)).toBe(afterOff);

    // Wave 6.00 — with cadence Off the badge shows humanized time-since-fetch.
    // 15s elapsed since the only fetch (the initial one at mount).
    expect(screen.getByTestId("obs-updated-badge").textContent).toBe("Updated 15s ago");
  });

  it("selecting 1s causes a fresh fetch every second", async () => {
    const fetchMock = installFetchMock();
    renderRoute();
    await flush(0);
    fireEvent.change(screen.getByTestId("obs-refresh-select"), { target: { value: "1000" } });
    await flush(0); // immediate fetch from cadence change
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
    // Default cadence is 2s — badge is just "2s", no "Updated Ns ago" prefix.
    expect(badge.textContent).toBe("2s");

    // 1s ticker advance — still just "2s" (no time-since text in this mode).
    await flush(1000);
    expect(badge.textContent).toBe("2s");

    // Cadence tick fires + refetches — badge is still just "2s".
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

    // Cross the 60s boundary → switches to minutes.
    await flush(78_000); // total 90s
    expect(badge.textContent).toBe("Updated 1m ago");
  });

  it("Wave 6.00 — manual refresh button fires a fetch and bumps the pulse key", async () => {
    const fetchMock = installFetchMock();
    renderRoute();
    await flush(0);
    // Turn polling off so only the manual click drives subsequent fetches.
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
    // Once the in-flight fetch resolves the button is enabled again.
    expect(button.disabled).toBe(false);
  });

  it("passes the latest shards through to the ShardMetricsStrip", async () => {
    installFetchMock();
    renderRoute();
    await flush(0);
    const strip = screen.getByTestId("shard-metrics-strip");
    expect(strip.textContent).toContain("shard-alpha");
    expect(strip.textContent).toContain("shard-beta");
  });

  it("keeps last data and shows an inline error pill when a later fetch fails", async () => {
    let mode: "ok" | "fail" = "ok";
    installFetchMock((url) => {
      if (mode === "fail") return Promise.reject(new Error("boom"));
      return defaultHandler(url);
    });
    renderRoute();
    await flush(0);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByTestId("obs-refresh-error")).toBeNull();

    mode = "fail";
    await flush(2000); // next cadence tick fails
    expect(screen.getByTestId("obs-refresh-error")).toBeInTheDocument();
    // Last successful value is still visible.
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});


// Wave 6.00 — compact unit-boundary tests for the time-since humanizer.
describe("humanizeSeconds", () => {
  it("renders sub-minute values as seconds", () => {
    expect(humanizeSeconds(0)).toBe("0s");
    expect(humanizeSeconds(12)).toBe("12s");
    expect(humanizeSeconds(59)).toBe("59s");
  });

  it("crosses to minutes at 60s and floors", () => {
    expect(humanizeSeconds(60)).toBe("1m");
    expect(humanizeSeconds(90)).toBe("1m"); // 90s → 1m (floored)
    expect(humanizeSeconds(60 * 59)).toBe("59m");
  });

  it("crosses to hours at 60m and floors", () => {
    expect(humanizeSeconds(60 * 60)).toBe("1h");
    expect(humanizeSeconds(60 * 70)).toBe("1h"); // 70m → 1h (floored)
    expect(humanizeSeconds(60 * 60 * 23)).toBe("23h");
  });

  it("crosses to days at 24h and floors", () => {
    expect(humanizeSeconds(60 * 60 * 24)).toBe("1d");
    expect(humanizeSeconds(60 * 60 * 26)).toBe("1d"); // 26h → 1d (floored)
    expect(humanizeSeconds(60 * 60 * 24 * 3)).toBe("3d");
  });
});
