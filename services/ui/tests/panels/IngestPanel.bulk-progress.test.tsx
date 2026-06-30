// Wave 7.0.8 — IngestPanel bulk-ingest progress.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SUMMARY_VISIBLE_MS } from "../../src/lib/ingestRunState";
import { renderIngestPanel } from "./ingestPanelTestHelpers";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2></header>
      <div>{children}</div>
    </section>
  ),
}));

const preflightPass = {
  ok: true,
  checks: {
    idx_sens: { ok: true, missing: [] },
    frtb_library: { ok: true, loaded: true },
    stream: { ok: true, exists: true },
  },
  can_rebuild: false,
};

function mockFetch() {
  let snapshotCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => preflightPass };
    if (url.endsWith("/admin/host-info")) {
      return { ok: true, json: async () => ({
        cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32,
        bulk_loader_pool_size: 32, bulk_loader_replicas: 1, shards: null, target_label: null,
      }) };
    }
    if (url.includes("/observability/memory")) {
      return { ok: true, json: async () => ({ used_memory_human: "0B" }) };
    }
    if (url.endsWith("/admin/index-count")) {
      return { ok: true, json: async () => ({ count: 0, index_name: "sens:", refreshing: false }) };
    }
    if (url.endsWith("/ingest/bulk/start") && method === "POST") {
      const body = JSON.parse(String((init as { body?: string }).body));
      return { ok: true, json: async () => ({
        ok: true, run_id: "01RUN", rows_total: body.rows,
        batch_size: 500, concurrency: 32, workers: body.workers ?? 2,
        bulk_loader_base: "http://bl:8086", started_at_iso: new Date().toISOString(),
      }) };
    }
    if (url.endsWith("/ingest/snapshot")) {
      snapshotCalls += 1;
      const done = snapshotCalls >= 3;
      return { ok: true, json: async () => ({
        ok: true, target_label: "local",
        cluster: { sens_count: 0, sens_count_refreshing: false, memory_bytes: 0, memory_human: "0B" },
        loader: { in_flight: done ? 0 : 5, flush_rps: done ? 0 : 12000, flushed_total: 0, throttled: false, recent_429_count: 0 },
        runs: [{
          run_id: "01RUN", status: done ? "done" : "running", rows_total: 10000,
          rows_sent: done ? 10000 : 5000, rows_written: done ? 10000 : 5000,
          rows_per_sec_producer: 0, rows_per_sec_write: 0,
          phase: done ? "complete" : "producing", workers: 2, started_at_iso: new Date().toISOString(),
        }],
        focused_run_id: "01RUN",
      }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

function renderPanel() {
  return renderIngestPanel();
}

describe("IngestPanel — bulk progress", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("renders progress bar driven by rows_written during an active run", async () => {
    mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-start-btn"));
    await waitFor(() => expect(screen.getByTestId("ingest-run-card")).toBeInTheDocument());
    expect(screen.getByTestId("phase-progress-ingest-text").textContent).toMatch(/5,000\s*\/\s*10,000/);
  });

  it("hides progress after completion summary", async () => {
    mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-start-btn"));
    await waitFor(() => expect(screen.getByTestId("ingest-run-card")).toBeInTheDocument());

    act(() => { vi.advanceTimersByTime(3000); });
    await waitFor(() => expect(screen.getByTestId("ingest-run-summary")).toBeInTheDocument());
    act(() => { vi.advanceTimersByTime(SUMMARY_VISIBLE_MS + 100); });
    await waitFor(() => expect(screen.queryByTestId("ingest-run-card")).not.toBeInTheDocument());
  });
});
