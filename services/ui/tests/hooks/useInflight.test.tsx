// Wave 5.16z2 — tests for the useInflight() hook.
//
// Covers the two transport branches: the SSE-first happy path (EventSource
// dispatches a "change" event → state updates) and the polling fallback the
// hook switches to when EventSource is unavailable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useInflight } from "../../src/hooks/useInflight";

interface MockListener { type: string; fn: EventListener }

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  listeners: MockListener[] = [];
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: EventListener): void { this.listeners.push({ type, fn }); }
  removeEventListener(type: string, fn: EventListener): void {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
  }
  close(): void { this.closed = true; this.readyState = 2; }
  emit(type: string, data: unknown): void {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const l of this.listeners) if (l.type === type) l.fn(ev);
    if (type === "message" && this.onmessage) this.onmessage(ev);
  }
  fail(): void { if (this.onerror) this.onerror(new Event("error")); }
}

describe("useInflight()", () => {
  beforeEach(() => { MockEventSource.instances = []; });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("subscribes to /inflight/stream and applies change events to state", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn());
    const { result, unmount } = renderHook(() => useInflight());
    expect(result.current.ready).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toMatch(/\/inflight\/stream$/);

    await act(async () => {
      MockEventSource.instances[0]!.emit("change", {
        count: 2,
        items: [
          { id: "a", kind: "loadgen", label: "loadgen-1", started_at: 1 },
          { id: "b", kind: "ingest", label: "ingest-3", started_at: 2 },
        ],
        stale: [],
      });
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.count).toBe(2);
    expect(result.current.items.map((it) => it.label)).toEqual(["loadgen-1", "ingest-3"]);

    unmount();
    expect(MockEventSource.instances[0]!.closed).toBe(true);
  });

  it("falls back to polling /inflight when EventSource is unavailable", async () => {
    vi.stubGlobal("EventSource", undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        count: 1,
        items: [{ id: "x", kind: "loadgen", label: "loadgen-2", started_at: 1 }],
        stale: [],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useInflight());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.count).toBe(1);
    expect(result.current.items[0]!.label).toBe("loadgen-2");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/\/inflight$/);
  });

  it("falls back to polling when EventSource fires onerror", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ count: 3, items: [], stale: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useInflight());
    await act(async () => { MockEventSource.instances[0]!.fail(); });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.count).toBe(3);
    expect(fetchMock).toHaveBeenCalled();
  });
});
