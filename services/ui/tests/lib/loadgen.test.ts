// RED — typed client for the api's /loadgen/* surface.
//
// Mirrors the lib/sources.ts pattern: thin fetch wrappers, no implicit retry,
// errors surface as Error instances. The SSE subscription uses EventSource so
// we stub the global here.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startLoadgen,
  stopLoadgen,
  getLoadgenStatus,
  subscribeMetrics,
  type LoadgenStartRequest,
  type LoadgenMetricsFrame,
} from "../../src/lib/loadgen";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("loadgen api client", () => {
  it("startLoadgen POSTs JSON to /loadgen/start and returns the body", async () => {
    let captured: { url: string; method?: string; body?: unknown; ct?: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        ct: (init?.headers as Record<string, string> | undefined)?.["content-type"],
      };
      return jsonResponse({ running: true, config: { concurrency: 50, duration_sec: 60, mix: { pivot: 0.5, calc: 0.5 } } }, 202);
    }) as typeof fetch;
    const cfg: LoadgenStartRequest = { concurrency: 50, duration_sec: 60, mix: { pivot: 0.5, calc: 0.5 } };
    const res = await startLoadgen(cfg);
    expect(captured!.url).toMatch(/\/loadgen\/start$/);
    expect(captured!.method).toBe("POST");
    expect(captured!.ct).toMatch(/application\/json/);
    expect(captured!.body).toEqual(cfg);
    expect(res.running).toBe(true);
  });

  it("startLoadgen throws on non-2xx", async () => {
    globalThis.fetch = (async () => new Response("bad", { status: 500 })) as typeof fetch;
    await expect(startLoadgen({ concurrency: 1 })).rejects.toThrow();
  });

  it("stopLoadgen POSTs to /loadgen/stop and returns the body", async () => {
    let url: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = typeof input === "string" ? input : input.toString();
      expect(init?.method).toBe("POST");
      return jsonResponse({ stopped: true });
    }) as typeof fetch;
    const res = await stopLoadgen();
    expect(url!).toMatch(/\/loadgen\/stop$/);
    expect(res.stopped).toBe(true);
  });

  it("getLoadgenStatus GETs /loadgen/status and returns the body", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        running: true,
        config: { concurrency: 10, duration_sec: 60, mix: { pivot: 0.5, calc: 0.5 } },
        snapshot: { total_requests: 100, errors: 0, throughput_rps: 50 },
      })) as typeof fetch;
    const res = await getLoadgenStatus();
    expect(res.running).toBe(true);
    expect(res.config?.concurrency).toBe(10);
  });
});

describe("subscribeMetrics (SSE)", () => {
  it("opens an EventSource at /loadgen/metrics and parses data: frames as JSON", () => {
    const listeners: Record<string, ((ev: MessageEvent) => void) | null> = { message: null };
    class FakeES {
      url: string;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      closed = false;
      constructor(url: string) {
        this.url = url;
        Object.defineProperty(this, "onmessage", {
          set(fn) { listeners.message = fn; },
          get() { return listeners.message; },
        });
      }
      close() { this.closed = true; }
    }
    const original = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeES as unknown;
    try {
      const onFrame = vi.fn();
      const stop = subscribeMetrics(onFrame);
      const frame: LoadgenMetricsFrame = {
        ts: 1, throughput_rps: 0, latency: { p50: 0, p95: 0, p99: 0 },
        errors: 0, total_requests: 0,
        per_endpoint: {
          pivot: { count: 0, errors: 0, p50: 0, p95: 0, p99: 0 },
          calc: { count: 0, errors: 0, p50: 0, p95: 0, p99: 0 },
        },
        running: true, elapsed_sec: 0,
      };
      listeners.message!({ data: JSON.stringify(frame) } as MessageEvent);
      expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ ts: 1, running: true }));
      stop();
    } finally {
      if (original === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
      else (globalThis as { EventSource?: unknown }).EventSource = original;
    }
  });

  it("returns a disposer that closes the EventSource", () => {
    let closed = false;
    class FakeES {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor(_url: string) { /* no-op */ }
      close() { closed = true; }
    }
    const original = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeES as unknown;
    try {
      const stop = subscribeMetrics(() => undefined);
      stop();
      expect(closed).toBe(true);
    } finally {
      if (original === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
      else (globalThis as { EventSource?: unknown }).EventSource = original;
    }
  });
});
