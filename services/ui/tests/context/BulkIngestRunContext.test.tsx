// Wave 7.0.8 — bulk ingest progress persistence across page refresh.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { BulkIngestRunProvider, useBulkIngestRun, useIngestRun } from "../../src/context/BulkIngestRunContext";
import { BULK_INGEST_STORAGE_KEY } from "../../src/lib/bulkIngestState";
import { SUMMARY_VISIBLE_MS } from "../../src/lib/ingestRunState";

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
            rows_written: 4200,
          }),
        };
      }
      if (url.endsWith("/ingest/snapshot")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            target_label: "local",
            cluster: { sens_count: 0, sens_count_refreshing: false, memory_bytes: 0, memory_human: "0B" },
            loader: { in_flight: 0, flush_rps: 4200, flushed_total: 4200, throttled: false, recent_429_count: 0 },
            runs: [{
              run_id: "01RESUME",
              status: "running",
              rows_total: 10_000,
              rows_sent: 4200,
              rows_written: 4200,
              rows_per_sec_producer: 4200,
              rows_per_sec_write: 4200,
              phase: "producing",
              workers: 2,
              started_at_iso: new Date().toISOString(),
            }],
            focused_run_id: "01RESUME",
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
            rows_written: 1000,
          }),
        };
      }
      if (url.endsWith("/ingest/snapshot")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            target_label: "local",
            cluster: { sens_count: 0, sens_count_refreshing: false, memory_bytes: 0, memory_human: "0B" },
            loader: { in_flight: 0, flush_rps: 0, flushed_total: 1000, throttled: false, recent_429_count: 0 },
            runs: [{
              run_id: "01CANCEL",
              status,
              rows_total: 10_000,
              rows_sent: 1000,
              rows_written: 1000,
              rows_per_sec_producer: 0,
              rows_per_sec_write: 0,
              phase: "producing",
              workers: 2,
              started_at_iso: new Date().toISOString(),
            }],
            focused_run_id: "01CANCEL",
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
    vi.advanceTimersByTime(SUMMARY_VISIBLE_MS + 100);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="run-id"]')?.textContent).toBe("");
    });
  });

  it("keeps polling progress while the ingest panel is unmounted", async () => {
    localStorage.setItem(BULK_INGEST_STORAGE_KEY, JSON.stringify({
      run_id: "01NAV",
      rows_total: 50_000,
      started_at: Date.now(),
    }));
    let rowsSent = 12_000;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/ingest/bulk/runs/01NAV")) {
        return {
          ok: true,
          json: async () => ({
            run_id: "01NAV",
            status: "running",
            rows_total: 50_000,
            rows_sent: rowsSent,
            rows_skipped: 0,
            batch_size: 500,
            concurrency: 32,
            ms: 2000,
            started_at_iso: new Date().toISOString(),
            bulk_loader_base: "http://bl:8086",
            rows_per_sec: 6000,
            rows_written: rowsSent,
          }),
        };
      }
      if (url.endsWith("/ingest/snapshot")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            target_label: "local",
            cluster: { sens_count: 0, sens_count_refreshing: false, memory_bytes: 0, memory_human: "0B" },
            loader: { in_flight: 2, flush_rps: 6000, flushed_total: rowsSent, throttled: false, recent_429_count: 0 },
            runs: [{
              run_id: "01NAV",
              status: "running",
              rows_total: 50_000,
              rows_sent: rowsSent,
              rows_written: rowsSent,
              rows_per_sec_producer: 6000,
              rows_per_sec_write: 6000,
              phase: "producing",
              workers: 4,
              started_at_iso: new Date().toISOString(),
            }],
            focused_run_id: "01NAV",
          }),
        };
      }
      if (url.endsWith("/ingest/bulk/runs")) {
        return { ok: true, json: async () => ({ active: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    function Shell({ onIngestPage }: { onIngestPage: boolean }) {
      const { view } = useIngestRun();
      return (
        <div>
          <span data-testid="page">{onIngestPage ? "ingest" : "other"}</span>
          <span data-testid="written">{view.written}</span>
        </div>
      );
    }

    const { rerender } = render(
      <BulkIngestRunProvider><Shell onIngestPage /></BulkIngestRunProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="written"]')?.textContent).toBe("12000");
    });

    rerender(<BulkIngestRunProvider><Shell onIngestPage={false} /></BulkIngestRunProvider>);
    rowsSent = 18_000;
    vi.advanceTimersByTime(1_100);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="written"]')?.textContent).toBe("18000");
    });

    rerender(<BulkIngestRunProvider><Shell onIngestPage /></BulkIngestRunProvider>);
    expect(document.querySelector('[data-testid="written"]')?.textContent).toBe("18000");
  });
});
