// Wave 5.16z1 — tests for the useBootstrapStatus() hook.
//
// Verifies the polling-window discipline (running/failed start the interval,
// idle/ready leave it stopped) and the connections:active-changed event
// triggering an immediate refetch.
//
// Spies on the global setInterval/clearInterval so the polling decision is
// observable without depending on wall-clock time — and so vitest fake
// timers don't collide with @testing-library/react's waitFor() internals.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useBootstrapStatus } from "../../src/hooks/useBootstrapStatus";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Flush microtasks + a macrotask so any pending fetch().then() chain and
// the React re-render scheduled by setSnapshot() has settled before we
// run assertions.
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

interface IntervalSpy {
  setCalls: Array<{ cb: () => void; ms: number; id: number }>;
  clearCalls: number[];
  trigger: (id: number) => void;
  restore: () => void;
}

// Only the hook's own polling interval (1500ms) is tracked here — we let
// any other setInterval call (notably the one @testing-library/react's
// waitFor() uses internally to poll its predicate at ~50ms) fall through
// to the real timer so the test harness keeps working.
const POLL_MS = 1500;

function installIntervalSpy(): IntervalSpy {
  const setCalls: IntervalSpy["setCalls"] = [];
  const clearCalls: number[] = [];
  let nextId = 1;
  const origSet = globalThis.setInterval;
  const origClear = globalThis.clearInterval;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setInterval = ((cb: () => void, ms: number, ...rest: unknown[]): number => {
    if (ms === POLL_MS) {
      const id = -nextId++;
      setCalls.push({ cb, ms, id });
      return id as unknown as number;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origSet as any)(cb, ms, ...rest);
  }) as unknown as typeof globalThis.setInterval;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).clearInterval = ((id: number) => {
    if (typeof id === "number" && id < 0) {
      clearCalls.push(id);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (origClear as any)(id);
  }) as unknown as typeof globalThis.clearInterval;
  return {
    setCalls,
    clearCalls,
    trigger: (id: number) => {
      const entry = setCalls.find((e) => e.id === id);
      if (entry) entry.cb();
    },
    restore: () => {
      globalThis.setInterval = origSet;
      globalThis.clearInterval = origClear;
    },
  };
}

describe("useBootstrapStatus()", () => {
  let spy: IntervalSpy;
  beforeEach(() => { spy = installIntervalSpy(); });
  afterEach(() => {
    spy.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does NOT start polling while phase stays idle", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ phase: "idle" }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBootstrapStatus());
    await flush();
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spy.setCalls).toHaveLength(0);
  });

  it("starts a 1.5s polling interval when phase=running and stops it on a subsequent ready", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ phase: "running", target_label: "demo" }))
      .mockResolvedValueOnce(jsonResponse({ phase: "ready", target_label: "demo" }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBootstrapStatus());
    await flush();
    await waitFor(() => expect(result.current.phase).toBe("running"));
    expect(spy.setCalls).toHaveLength(1);
    expect(spy.setCalls[0]!.ms).toBe(1500);
    expect(spy.clearCalls).toHaveLength(0);

    // Manually fire the registered interval callback to simulate the next tick.
    await act(async () => { spy.trigger(spy.setCalls[0]!.id); });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(spy.clearCalls).toContain(spy.setCalls[0]!.id);
  });

  it("starts polling when phase=failed (so a Retry / re-activate can be observed)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ phase: "failed", target_label: "demo", err: "boom" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBootstrapStatus());
    await flush();
    await waitFor(() => expect(result.current.phase).toBe("failed"));
    expect(spy.setCalls).toHaveLength(1);
    expect(spy.setCalls[0]!.ms).toBe(1500);
  });

  it("refetches immediately on connections:active-changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ phase: "idle" }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useBootstrapStatus());
    await flush();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new CustomEvent("connections:active-changed"));
    });
    await flush();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
