// Wave 5.40b — localStorage + status-poll reconnect on the global generator
// run provider. Verifies the cold-start / resume-running / resume-terminal /
// resume-404 / orphan-discovery / unmount-cleanup paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import {
  AUTO_DISMISS_DONE_MS,
  AUTO_DISMISS_ERROR_MS,
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

  // Wave 6.10 — pill stability. The AppShell nav pill only renders while the
  // provider's `run` is non-null. Simulate a long-running run (60s of polls
  // all returning "running") and confirm `run.runId` stays set the whole time
  // so the pill never flickers out mid-run.
  it("pill stability: run + runId persist across 60s of running-status polls", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ run_id: "01HXLONG", rows_total: 1000, started_at: Date.now() }));
    let rowsDone = 50;
    fetchMock.on(
      (url, method) => /\/generator\/runs\/[^/]+\/status$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { run_id: "01HXLONG", status: "running", rows_done: rowsDone, rows_total: 1000, rows_per_sec: 800, elapsed_ms: rowsDone * 10 },
      }),
    );
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({ status: 200, body: { active: [] } }),
    );

    vi.useFakeTimers();
    const ui = renderProvider();
    // Drain the mount-time async fetch chain under fake timers.
    for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
    expect(ui.value.run).not.toBeNull();
    expect(ui.value.run!.runId).toBe("01HXLONG");
    expect(ui.value.run!.status).toBe("running");

    // Advance 60s in 1s ticks so each 500ms poll interval fires and its
    // async response is drained. The pill must remain mounted the whole time.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1000) {
      rowsDone = Math.min(950, rowsDone + 10);
      await act(async () => {
        vi.advanceTimersByTime(1000);
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(ui.value.run, `run vanished at ~${elapsed + 1000}ms`).not.toBeNull();
      expect(ui.value.run!.runId).toBe("01HXLONG");
      expect(ui.value.run!.status).toBe("running");
    }
    vi.useRealTimers();
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

  // Wave 6.44.F — defence-in-depth for the cancel-path leak. The
  // server-side /generator/runs filter normally returns running-only, but
  // if a registry entry transitions terminal between that filter pass and
  // our adoption the orphan response may still include a `status:"cancelled"`
  // (or other terminal) row. The provider must NOT start polling against
  // such an entry — doing so would transiently set `run.status="running"`
  // and re-seed the IndexingProgress anchor, leaving the bar stuck at 0%.
  it("(6.44.F) orphan-discovery never starts polling for a terminal entry returned mid-grace", async () => {
    fetchMock.on(
      (url, method) => /\/generator\/runs$/.test(url) && method === "GET",
      () => ({
        status: 200,
        body: { active: [{ run_id: "01HXTERM", status: "cancelled", rows_done: 0, rows_total: 100_000 }] },
      }),
    );
    // If startPolling were called the provider would hit this URL; the
    // assertion below confirms it never does.
    const statusCalls: string[] = [];
    fetchMock.on(
      (url, method) => /\/generator\/runs\/[^/]+\/status$/.test(url) && method === "GET",
      () => {
        statusCalls.push("called");
        return { status: 200, body: { run_id: "01HXTERM", status: "running", rows_done: 0, rows_total: 100_000, rows_per_sec: 0, elapsed_ms: 0 } };
      },
    );

    const ui = renderProvider();
    // Drain the mount-time orphan-discovery promise chain.
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    // Wait a poll interval; if startPolling had been invoked a status
    // request would have fired by now.
    await new Promise((r) => setTimeout(r, 600));

    // Invariants: run stays null AND no status polls were issued.
    expect(ui.value.run).toBeNull();
    expect(statusCalls).toHaveLength(0);
    // localStorage stayed clean too — the provider didn't writeStored a
    // terminal entry.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

// Wave 5.45 — auto-dismiss timer for the terminal summary so the pill clears
// itself a few seconds after a run finishes / is cancelled / errors.
describe("<GeneratorRunProvider /> — Wave 5.45 auto-dismiss", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Builds a stub fetch that returns a real Response with a ReadableStream
  // body for /generator/start/stream so the SSE reader inside
  // startGeneratorStream sees actual chunks, while every other URL gets a
  // benign JSON 200. Each call gets a fresh body so a follow-up startRun in
  // the same test doesn't trip on a locked / already-consumed stream.
  function stubStreamFetch(chunks: string[]) {
    const enc = new TextEncoder();
    const makeBody = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/generator\/start\/stream$/.test(url)) {
        return new Response(makeBody(), { headers: { "content-type": "text/event-stream" } });
      }
      if (/\/generator\/runs$/.test(url)) {
        return new Response(JSON.stringify({ active: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch);
  }

  // Drains promise microtasks so the streaming reader inside
  // startGeneratorStream advances even under fake timers.
  async function pumpMicrotasks(n = 10): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  it("SSE onTerminal with cancelled:true clears run after AUTO_DISMISS_DONE_MS", async () => {
    stubStreamFetch([
      `data: ${JSON.stringify({ run_id: "rcc", done: true, rows_queued: 42, ms: 100, cancelled: true })}\n\n`,
    ]);
    const ui = renderProvider();
    // Drain the mount-time orphan-discovery promise.
    await act(async () => { await pumpMicrotasks(); });

    vi.useFakeTimers();
    act(() => { ui.value.startRun(null); });
    await act(async () => { await pumpMicrotasks(20); });
    expect(ui.value.run?.status).toBe("cancelled");

    // Just before the dismiss window — still visible.
    await act(async () => { vi.advanceTimersByTime(AUTO_DISMISS_DONE_MS - 100); });
    expect(ui.value.run).not.toBeNull();

    // Past the window — pill clears itself.
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(ui.value.run).toBeNull();
  });

  it("SSE onTerminal with error clears run after AUTO_DISMISS_ERROR_MS", async () => {
    stubStreamFetch([
      `data: ${JSON.stringify({ run_id: "rerr", done: true, rows_queued: 0, ms: 5, cancelled: false, error: "boom" })}\n\n`,
    ]);
    const ui = renderProvider();
    await act(async () => { await pumpMicrotasks(); });

    vi.useFakeTimers();
    act(() => { ui.value.startRun(null); });
    await act(async () => { await pumpMicrotasks(20); });
    expect(ui.value.run?.status).toBe("done");
    expect(ui.value.error).toBe("boom");

    // The DONE window must NOT clear it — error uses the longer window.
    await act(async () => { vi.advanceTimersByTime(AUTO_DISMISS_DONE_MS + 500); });
    expect(ui.value.run).not.toBeNull();

    // Cross the ERROR threshold.
    await act(async () => {
      vi.advanceTimersByTime(AUTO_DISMISS_ERROR_MS - AUTO_DISMISS_DONE_MS);
    });
    expect(ui.value.run).toBeNull();
    expect(ui.value.error).toBeNull();
  });

  it("polling-mode terminal (cancelled) clears run after AUTO_DISMISS_DONE_MS", async () => {
    // First /status call returns running so the provider enters startPolling;
    // the next tick returns cancelled so the polling-mode terminal branch
    // fires and schedules the auto-dismiss timer. Fake timers are armed
    // before mount so the scheduleDismiss setTimeout is the FAKE one.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ run_id: "rpoll", rows_total: 200, started_at: Date.now() }));
    let statusCalls = 0;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/generator\/runs\/[^/]+\/status$/.test(url)) {
        statusCalls += 1;
        if (statusCalls === 1) {
          return new Response(
            JSON.stringify({ run_id: "rpoll", status: "running", rows_done: 50, rows_total: 200, rows_per_sec: 1000, elapsed_ms: 50 }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ run_id: "rpoll", status: "cancelled", rows_done: 88, rows_total: 200, rows_per_sec: 0, elapsed_ms: 150 }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (/\/generator\/runs$/.test(url)) {
        return new Response(JSON.stringify({ active: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch);

    vi.useFakeTimers();
    const ui = renderProvider();
    // Mount effect's async fetch needs microtask drains under fake timers.
    await act(async () => { await pumpMicrotasks(20); });
    expect(ui.value.run?.status).toBe("running");

    // Advance one polling interval (500ms in the provider) so the next /status
    // call fires and routes through the polling-mode terminal branch.
    await act(async () => {
      vi.advanceTimersByTime(500);
      await pumpMicrotasks(20);
    });
    expect(ui.value.run?.status).toBe("cancelled");

    // Auto-dismiss timer was armed with the fake setTimeout; advance past it.
    await act(async () => { vi.advanceTimersByTime(AUTO_DISMISS_DONE_MS + 100); });
    expect(ui.value.run).toBeNull();
  });

  it("startRun during the dismiss window clears the previous timer and keeps the new run rendered", async () => {
    // First stream emits a terminal frame so the dismiss timer is armed; the
    // second startRun gets a stream that stays open without emitting frames
    // so the new run sticks in "running" while we verify the OLD dismiss
    // timer was cleared.
    const enc = new TextEncoder();
    let streamCalls = 0;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/generator\/start\/stream$/.test(url)) {
        streamCalls += 1;
        if (streamCalls === 1) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(enc.encode(
                `data: ${JSON.stringify({ run_id: "rfirst", done: true, rows_queued: 1, ms: 1, cancelled: false })}\n\n`,
              ));
              controller.close();
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        // Hold the second stream open indefinitely.
        const body = new ReadableStream<Uint8Array>({ pull() { /* idle */ } });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (/\/generator\/runs$/.test(url)) {
        return new Response(JSON.stringify({ active: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch);

    const ui = renderProvider();
    await act(async () => { await pumpMicrotasks(); });

    vi.useFakeTimers();
    act(() => { ui.value.startRun(null); });
    await act(async () => { await pumpMicrotasks(20); });
    expect(ui.value.run?.status).toBe("done");

    // Halfway through the dismiss window kick off a new run.
    await act(async () => { vi.advanceTimersByTime(AUTO_DISMISS_DONE_MS / 2); });
    expect(ui.value.run).not.toBeNull();
    act(() => { ui.value.startRun(null); });
    expect(ui.value.run?.status).toBe("running");
    expect(ui.value.run?.runId).toBeNull();

    // Advance past the moment the ORIGINAL dismiss timer would have fired.
    // The second stream is idle (no frames), so if the old timer is still
    // armed it would null the run.
    await act(async () => {
      vi.advanceTimersByTime(AUTO_DISMISS_DONE_MS);
      await pumpMicrotasks(5);
    });
    expect(ui.value.run).not.toBeNull();
    expect(ui.value.run?.status).toBe("running");
  });

  it("unmount during the dismiss window does not setState on an unmounted provider", async () => {
    stubStreamFetch([
      `data: ${JSON.stringify({ run_id: "rumnt", done: true, rows_queued: 0, ms: 0, cancelled: true })}\n\n`,
    ]);
    const errors: unknown[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });

    const ui = renderProvider();
    await act(async () => { await pumpMicrotasks(); });

    vi.useFakeTimers();
    act(() => { ui.value.startRun(null); });
    await act(async () => { await pumpMicrotasks(20); });
    expect(ui.value.run?.status).toBe("cancelled");

    // Halfway through the dismiss window unmount, then keep advancing
    // — the dismiss timer must NOT fire on the unmounted provider.
    await act(async () => { vi.advanceTimersByTime(AUTO_DISMISS_DONE_MS / 2); });
    ui.unmount();
    await act(async () => { vi.advanceTimersByTime(AUTO_DISMISS_DONE_MS); });

    // React's setState-after-unmount surface is `console.error` — check no
    // such warning showed up.
    expect(errors).toHaveLength(0);
    errSpy.mockRestore();
  });
});
