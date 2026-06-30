// Ingest page — full-page behavior contract.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SUMMARY_VISIBLE_MS } from "../../src/lib/ingestRunState";
import { renderIngestPanel } from "./ingestPanelTestHelpers";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-testid="panel-card" data-title={title}><h2>{title}</h2>{children}</section>
  ),
}));

const preflightPass = {
  ok: true,
  checks: { idx_sens: { ok: true, missing: [] }, frtb_library: { ok: true, loaded: true }, stream: { ok: true, exists: true } },
  can_rebuild: false,
};

function mockFetch(opts?: {
  sensSequence?: Array<{ count: number; refreshing: boolean }>;
  runSequence?: Array<{ status: string; rows_written: number; rows_total?: number }>;
}) {
  let sensIdx = 0;
  let snapshotCalls = 0;
  const sensSequence = opts?.sensSequence ?? [{ count: 4_400_000, refreshing: false }];
  const runSequence = opts?.runSequence ?? [
    { status: "running", rows_written: 5000, rows_total: 10_000 },
    { status: "done", rows_written: 10_000, rows_total: 10_000 },
  ];
  const runId = "01RUN";

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => preflightPass };
    if (url.endsWith("/admin/host-info")) {
      return { ok: true, json: async () => ({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, bulk_loader_replicas: 1, shards: null, target_label: "local" }) };
    }
    if (url.includes("/observability/memory")) {
      return { ok: true, json: async () => ({
        used_memory: 3_221_225_472,
        used_memory_human: "1.2G",
        maxmemory_bytes: 8_589_934_592,
      }) };
    }
    if (url.includes("/admin/index-count")) {
      const snap = sensSequence[Math.min(sensIdx++, sensSequence.length - 1)]!;
      return { ok: true, json: async () => ({ count: snap.count, index_name: "sens:", refreshing: snap.refreshing }) };
    }
    if (url.endsWith("/ingest/bulk/start") && method === "POST") {
      const body = JSON.parse(String((init as { body?: string }).body));
      return { ok: true, json: async () => ({
        ok: true, run_id: runId, rows_total: body.rows, batch_size: 500, concurrency: 32,
        workers: body.workers ?? 2, bulk_loader_base: "http://bl:8086",
        started_at_iso: new Date().toISOString(),
      }) };
    }
    if (url.endsWith("/ingest/snapshot")) {
      const idx = Math.min(snapshotCalls++, runSequence.length - 1);
      const current = runSequence[idx]!;
      return { ok: true, json: async () => ({
        ok: true, target_label: "local",
        cluster: { sens_count: 0, sens_count_refreshing: false, memory_bytes: 0, memory_human: "0B" },
        loader: { in_flight: current.status === "running" ? 5 : 0, flush_rps: current.status === "running" ? 12000 : 0, flushed_total: 0, throttled: false, recent_429_count: 0 },
        runs: [{
          run_id: runId, status: current.status, rows_total: current.rows_total ?? 10_000,
          rows_sent: current.rows_written, rows_written: current.rows_written,
          rows_per_sec_producer: 0, rows_per_sec_write: 0, phase: current.status === "running" ? "producing" : "complete",
          workers: 2, started_at_iso: new Date().toISOString(),
        }],
        focused_run_id: runId,
      }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

describe("IngestPanel page contract", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("shows cluster tiles on load without snapshot polling", async () => {
    mockFetch();
    renderIngestPanel();
    await screen.findByTestId("ingest-cluster-tiles");
    expect(screen.getByTestId("ingest-tile-sens")).toHaveTextContent(/4,400,000/);
    expect(screen.getByTestId("ingest-tile-memory")).toHaveTextContent(/1\.2G/);
    expect(screen.getByTestId("ingest-tile-target")).toHaveTextContent(/local/);
    expect(screen.getByTestId("ingest-memory-bar")).toHaveAttribute("data-level", "green");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const snapshotCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/ingest/snapshot"));
    expect(snapshotCalls.length).toBe(0);
  });

  it("idle state shows preset picker in a single run zone card", async () => {
    mockFetch();
    renderIngestPanel();
    await screen.findByTestId("ingest-run-setup");
    expect(screen.getByTestId("ingest-tier-smoke")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-tier-benchmark")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-tier-stress")).toBeInTheDocument();
    expect(screen.queryByTestId("ingest-run-active")).not.toBeInTheDocument();
  });

  it("running state swaps preset picker for progress and inline write rate", async () => {
    mockFetch();
    renderIngestPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-start-btn"));

    await waitFor(() => expect(screen.getByTestId("ingest-run-active")).toBeInTheDocument());
    expect(screen.queryByTestId("ingest-run-setup")).not.toBeInTheDocument();
    expect(screen.getByTestId("ingest-run-write-rate")).toHaveTextContent(/12,000/);
    expect(screen.getByTestId("phase-progress-ingest-text").textContent).toMatch(/5,000/);
  });

  it("shows monotonic written progress then brief summary then returns to idle setup", async () => {
    mockFetch({
      runSequence: [
        { status: "running", rows_written: 8000 },
        { status: "running", rows_written: 7500 },
        { status: "done", rows_written: 10_000 },
      ],
    });
    renderIngestPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-start-btn"));

    await waitFor(() => expect(screen.getByTestId("ingest-run-card")).toBeInTheDocument());
    expect(screen.getByTestId("phase-progress-ingest-text").textContent).toMatch(/8,000/);

    act(() => { vi.advanceTimersByTime(2000); });
    await waitFor(() => expect(screen.getByTestId("ingest-run-summary")).toBeInTheDocument());
    expect(screen.getByTestId("ingest-run-summary")).toHaveTextContent(/Done — 10,000 rows in/);

    act(() => { vi.advanceTimersByTime(SUMMARY_VISIBLE_MS + 100); });
    await waitFor(() => expect(screen.queryByTestId("ingest-run-summary")).not.toBeInTheDocument());
    expect(screen.getByTestId("ingest-run-setup")).toBeInTheDocument();
  });

  it("refreshes keys-in-DB count on the 60s poll interval", async () => {
    mockFetch({
      sensSequence: [
        { count: 4_400_000, refreshing: false },
        { count: 4_500_000, refreshing: false },
      ],
    });
    renderIngestPanel();
    const sensTile = await screen.findByTestId("ingest-tile-sens");
    await waitFor(() => expect(sensTile.textContent).toMatch(/4,400,000/));

    act(() => { vi.advanceTimersByTime(60_000); });
    await waitFor(() => expect(sensTile.textContent).toMatch(/4,500,000/));
  });

  it("tucks destructive actions under advanced footer", async () => {
    mockFetch();
    renderIngestPanel();
    expect(await screen.findByTestId("ingest-admin-footer")).toBeInTheDocument();
    expect(screen.getByTestId("flush-db-btn")).toBeInTheDocument();
    expect(screen.getByTestId("stop-all-runs-btn")).toHaveTextContent(/stop all runs/i);
  });
});
