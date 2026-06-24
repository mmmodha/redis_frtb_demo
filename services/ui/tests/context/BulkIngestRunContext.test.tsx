// Wave 7.0.8 — bulk ingest progress persistence across page refresh.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { BulkIngestRunProvider, useBulkIngestRun } from "../../src/context/BulkIngestRunContext";
import { BULK_INGEST_STORAGE_KEY } from "../../src/lib/bulkIngestState";

function makeMemoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

function Probe() {
  const { bulkRunId, bulkRun } = useBulkIngestRun();
  return (
    <div>
      <span data-testid="run-id">{bulkRunId ?? ""}</span>
      <span data-testid="rows-sent">{bulkRun?.rows_sent ?? 0}</span>
      <span data-testid="status">{bulkRun?.status ?? ""}</span>
    </div>
  );
}

describe("BulkIngestRunContext", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("localStorage", makeMemoryStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("resumes a running bulk ingest from localStorage after remount", async () => {
    localStorage.setItem(BULK_INGEST_STORAGE_KEY, JSON.stringify({
      run_id: "01RESUME",
      rows_total: 10_000,
      started_at: Date.now(),
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/ingest/bulk/runs/01RESUME")) {
        return {
          ok: true,
          json: async () => ({
            run_id: "01RESUME",
            status: "running",
            rows_total: 10_000,
            rows_sent: 4200,
            rows_skipped: 0,
            batch_size: 500,
            concurrency: 32,
            ms: 1000,
            started_at_iso: new Date().toISOString(),
            bulk_loader_base: "http://bl:8086",
            rows_per_sec: 4200,
          }),
        };
      }
      if (url.endsWith("/ingest/bulk/runs")) {
        return { ok: true, json: async () => ({ active: [] }) };
      }
      if (url.endsWith("/ingest/bulk/load-status")) {
        return {
          ok: true,
          json: async () => ({
            pool_size: 8,
            connected: 8,
            dispatcher: { in_flight: 0, high_water: 8000 },
            workers: [{ id: 0, flushed: 4000 }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const { unmount } = render(
      <BulkIngestRunProvider><Probe /></BulkIngestRunProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="run-id"]')?.textContent).toBe("01RESUME");
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="rows-sent"]')?.textContent).toBe("4200");
    });
    unmount();

    render(<BulkIngestRunProvider><Probe /></BulkIngestRunProvider>);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="run-id"]')?.textContent).toBe("01RESUME");
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="rows-sent"]')?.textContent).toBe("4200");
    });
  });

  it("clears stale localStorage when the run 404s", async () => {
    localStorage.setItem(BULK_INGEST_STORAGE_KEY, JSON.stringify({
      run_id: "01STALE",
      rows_total: 1000,
      started_at: Date.now(),
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/ingest/bulk/runs/01STALE")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.endsWith("/ingest/bulk/runs")) {
        return { ok: true, json: async () => ({ active: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    render(<BulkIngestRunProvider><Probe /></BulkIngestRunProvider>);
    await waitFor(() => {
      expect(localStorage.getItem(BULK_INGEST_STORAGE_KEY)).toBeNull();
    });
  });

  it("clears the progress UI a few seconds after cancel", async () => {
    localStorage.setItem(BULK_INGEST_STORAGE_KEY, JSON.stringify({
      run_id: "01CANCEL",
      rows_total: 10_000,
      started_at: Date.now(),
    }));
    let status = "running";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/ingest/bulk/runs/01CANCEL")) {
        return {
          ok: true,
          json: async () => ({
            run_id: "01CANCEL",
            status,
            rows_total: 10_000,
            rows_sent: 1000,
            rows_skipped: 0,
            batch_size: 500,
            concurrency: 32,
            ms: 1000,
            started_at_iso: new Date().toISOString(),
            bulk_loader_base: "http://bl:8086",
            rows_per_sec: 0,
          }),
        };
      }
      if (url.endsWith("/ingest/bulk/cancel") && method === "POST") {
        status = "cancelled";
        return { ok: true, json: async () => ({ ok: true, run_id: "01CANCEL", status: "cancelled" }) };
      }
      if (url.endsWith("/ingest/bulk/runs")) {
        return { ok: true, json: async () => ({ active: [] }) };
      }
      if (url.endsWith("/ingest/bulk/load-status")) {
        return {
          ok: true,
          json: async () => ({
            pool_size: 8,
            connected: 8,
            dispatcher: { in_flight: 0, high_water: 8000 },
            workers: [{ id: 0, flushed: 1000 }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));

    function CancelProbe() {
      const { bulkRunId, cancelRun } = useBulkIngestRun();
      return (
        <div>
          <span data-testid="run-id">{bulkRunId ?? ""}</span>
          <button type="button" data-testid="cancel-btn" onClick={cancelRun}>Cancel</button>
        </div>
      );
    }

    render(
      <BulkIngestRunProvider><CancelProbe /></BulkIngestRunProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="run-id"]')?.textContent).toBe("01CANCEL");
    });
    document.querySelector<HTMLButtonElement>('[data-testid="cancel-btn"]')?.click();
    await waitFor(() => {
      expect(status).toBe("cancelled");
    });
    vi.advanceTimersByTime(4_500);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="run-id"]')?.textContent).toBe("");
    });
  });
});
