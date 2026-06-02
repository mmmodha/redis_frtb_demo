// Wave 5.40b — localStorage + status-poll reconnect on the global generator
// run provider. Verifies the cold-start / resume-running / resume-terminal /
// resume-404 / orphan-discovery / unmount-cleanup paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import {
  GeneratorRunProvider,
  useGeneratorRun,
  type GeneratorRunContextValue,
} from "../../src/context/GeneratorRunContext";

const STORAGE_KEY = "generator-active-run";

// Captures the latest context value into a ref so each test can assert on the
// provider's `run` state without touching the DOM.
function Capture(props: { onValue: (v: GeneratorRunContextValue) => void }) {
  const v = useGeneratorRun();
  props.onValue(v);
  return null;
}

function renderProvider() {
  let latest: GeneratorRunContextValue | null = null;
  const utils = render(
    <GeneratorRunProvider>
      <Capture onValue={(v) => { latest = v; }} />
    </GeneratorRunProvider>,
  );
  return { ...utils, get value(): GeneratorRunContextValue { return latest!; } };
}

interface RouteHandler {
  matches: (url: string, method: string) => boolean;
  respond: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

function makeFetchMock() {
  const calls: Array<{ url: string; method: string }> = [];
  const handlers: RouteHandler[] = [];
  const mock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    for (const h of handlers) {
      if (h.matches(url, method)) {
        const { status, body } = await h.respond();
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        } as unknown as Response;
      }
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  return {
    mock,
    calls,
    on(matches: RouteHandler["matches"], respond: RouteHandler["respond"]) {
      handlers.push({ matches, respond });
    },
  };
}

// Node 22's experimental globalThis.localStorage can shadow the jsdom one and
// stub out the standard API; build a small in-memory Storage shim per test so
// the provider's readStored/writeStored/clearStored helpers behave normally.
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

describe("<GeneratorRunProvider /> — Wave 5.40b reconnect", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>;
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.mock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cold start: no localStorage → provider mounts with run=null and only orphan-discovery fires", async () => {
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({ status: 200, body: { active: [] } }),
    );
    const ui = renderProvider();
    await waitFor(() => {
      expect(fetchMock.calls.some((c) => /\/generator\/runs$/.test(c.url))).toBe(true);
    });
    expect(ui.value.run).toBeNull();
    expect(fetchMock.calls.some((c) => /\/generator\/runs\/.+\/status$/.test(c.url))).toBe(false);
  });

  it("resume running: localStorage has run_id, /runs/:id/status returns running → polls and reflects advancing rows_done", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ run_id: "01HXRES", rows_total: 500, started_at: Date.now() }));
    let rowsDone = 100;
    fetchMock.on(
      (url, method) => /\/generator\/runs\/[^/]+\/status$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { run_id: "01HXRES", status: "running", rows_done: rowsDone, rows_total: 500, rows_per_sec: 1000, elapsed_ms: 100 },
      }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({ status: 200, body: { active: [] } }),
    );

    const ui = renderProvider();
    await waitFor(() => {
      expect(ui.value.run).not.toBeNull();
      expect(ui.value.run!.runId).toBe("01HXRES");
      expect(ui.value.run!.status).toBe("running");
      expect(ui.value.run!.rowsDone).toBe(100);
      expect(ui.value.run!.rowsTotal).toBe(500);
    });

    // Advance simulated progress and wait for the next poll tick to pick it up.
    rowsDone = 300;
    await waitFor(() => {
      expect(ui.value.run!.rowsDone).toBe(300);
    }, { timeout: 2000 });
  });

  it("resume terminal: /runs/:id/status returns done → shows terminal state, then clears localStorage after grace", async () => {
    vi.useFakeTimers();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ run_id: "01HXDONE", rows_total: 200, started_at: Date.now() }));
    fetchMock.on(
      (url, method) => /\/generator\/runs\/[^/]+\/status$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { run_id: "01HXDONE", status: "done", rows_done: 200, rows_total: 200, rows_per_sec: 0, elapsed_ms: 145 },
      }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({ status: 200, body: { active: [] } }),
    );

    const ui = renderProvider();
    // Drain the microtask queue so the async mount effect resolves.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(ui.value.run).not.toBeNull();
    expect(ui.value.run!.status).toBe("done");
    expect(ui.value.run!.rowsDone).toBe(200);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // Advance past the 30s grace window → localStorage gets cleared.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  it("resume 404: stale localStorage run_id → clears localStorage, run stays null", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ run_id: "01HXSTALE", rows_total: 200, started_at: Date.now() }));
    fetchMock.on(
      (url, method) => /\/generator\/runs\/[^/]+\/status$/.test(url) && method === "GET",
      () => ({ status: 404, body: { error: "unknown run_id" } }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({ status: 200, body: { active: [] } }),
    );

    const ui = renderProvider();
    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
    expect(ui.value.run).toBeNull();
  });

  it("cleanup on unmount: polling interval is cleared", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ run_id: "01HXPOLL", rows_total: 500, started_at: Date.now() }));
    fetchMock.on(
      (url, method) => /\/generator\/runs\/[^/]+\/status$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { run_id: "01HXPOLL", status: "running", rows_done: 100, rows_total: 500, rows_per_sec: 1000, elapsed_ms: 100 },
      }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({ status: 200, body: { active: [] } }),
    );

    const ui = renderProvider();
    await waitFor(() => {
      expect(ui.value.run).not.toBeNull();
      expect(ui.value.run!.status).toBe("running");
    });

    const beforeUnmount = fetchMock.calls.filter((c) => /\/generator\/runs\/[^/]+\/status$/.test(c.url)).length;
    ui.unmount();
    await new Promise((r) => setTimeout(r, 1200));
    const afterUnmount = fetchMock.calls.filter((c) => /\/generator\/runs\/[^/]+\/status$/.test(c.url)).length;
    // No new status polls fire after unmount (allow at most one in-flight tick).
    expect(afterUnmount - beforeUnmount).toBeLessThanOrEqual(1);
  });

  it("adopts orphan run from GET /generator/runs when localStorage is empty", async () => {
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { active: [{ run_id: "01HXORPHAN", status: "running", rows_done: 42, rows_total: 1000 }] },
      }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs\/[^/]+\/status$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { run_id: "01HXORPHAN", status: "running", rows_done: 80, rows_total: 1000, rows_per_sec: 800, elapsed_ms: 100 },
      }),
    );

    const ui = renderProvider();
    await waitFor(() => {
      expect(ui.value.run).not.toBeNull();
      expect(ui.value.run!.runId).toBe("01HXORPHAN");
      expect(ui.value.run!.status).toBe("running");
    });
    // localStorage was populated by the orphan-adoption path.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.run_id).toBe("01HXORPHAN");
    expect(stored.rows_total).toBe(1000);
  });

  it("adopts orphan when localStorage points to a different (404) run_id", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ run_id: "01HXGHOST", rows_total: 200, started_at: Date.now() }));
    fetchMock.on(
      (url, method) => /\/generator\/runs\/01HXGHOST\/status$/.test(url) && method === "GET",
      () => ({ status: 404, body: { error: "unknown run_id" } }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { active: [{ run_id: "01HXNEW", status: "running", rows_done: 10, rows_total: 800 }] },
      }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs\/01HXNEW\/status$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { run_id: "01HXNEW", status: "running", rows_done: 20, rows_total: 800, rows_per_sec: 200, elapsed_ms: 100 },
      }),
    );

    const ui = renderProvider();
    await waitFor(() => {
      expect(ui.value.run).not.toBeNull();
      expect(ui.value.run!.runId).toBe("01HXNEW");
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.run_id).toBe("01HXNEW");
  });
});
