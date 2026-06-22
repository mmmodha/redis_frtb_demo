// Wave 7.0.6.21 — IngestPanel integration: three-lane bulk-run progress.
//
// Covers the new layout introduced when the middle (Ingest) lane was
// swapped from a PhaseProgress bar to a RateGauge:
//   Lane 1 — Generation (PhaseProgress)
//   Lane 2 — Ingest     (RateGauge with throttle chip)
//   Lane 3 — Indexing   (PhaseProgress with denominator = generated, not requested)
//
// We also assert the chip flips through its three states as /load/status
// reports throttled / recovering / idle, and that a failing /load/status
// fetch degrades silently (no chip rendered, no console errors).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import { GeneratorRunProvider } from "../../src/context/GeneratorRunContext";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2>{actions}</header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: any) => (<aside data-signal={signal}>{children}</aside>),
}));
vi.mock("../../src/components/MetricTile", () => ({
  MetricTile: ({ label, value }: any) => (<div data-label={label}>{value}</div>),
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

interface MockOpts {
  rowsSent?: number;
  rowsTotal?: number;
  indexCount?: number;
  // /load/status response shape; null ⇒ failing fetch.
  loadStatus?: {
    throttled: boolean;
    recent_429_count: number;
    headroom_pct: number;
    in_flight?: number;
    high_water?: number;
  } | null;
}

function mockFetch(initial: MockOpts) {
  // Use a mutable holder so individual tests can swap the load-status
  // response between poll ticks (429 storm → recovery → idle).
  const state: { opts: MockOpts } = { opts: { ...initial } };
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources")) return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => ({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 1 }) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => ({ used_memory: 0, used_memory_human: "0B", ms: 1 }) };
    if (url.includes("/admin/index-count")) return { ok: true, json: async () => ({ count: state.opts.indexCount ?? 0, index_name: "idx:sens:v1" }) };
    if (url.endsWith("/admin/host-info")) return { ok: true, json: async () => ({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null }) };
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => preflightPass };
    if (url.endsWith("/ingest/shards")) return { ok: true, json: async () => ({ totalShards: 1 }) };
    if (url.endsWith("/ingest/bulk/start") && method === "POST") {
      const body = JSON.parse(String((init as any).body));
      return { ok: true, json: async () => ({
        ok: true, run_id: "01RUN", rows_total: body.rows,
        batch_size: 500, concurrency: 32, workers: body.workers ?? 1,
        bulk_loader_base: "http://bl:8086", started_at_iso: new Date().toISOString(),
      }) };
    }
    if (url.includes("/ingest/bulk/runs/")) {
      return { ok: true, json: async () => ({
        run_id: "01RUN", status: "running",
        rows_total: state.opts.rowsTotal ?? 10000,
        rows_sent: state.opts.rowsSent ?? 5000,
        rows_skipped: 0, batch_size: 500, concurrency: 32, workers: 1,
        ms: 1000, started_at_iso: new Date().toISOString(),
        bulk_loader_base: "http://bl:8086", rows_per_sec: 5000,
      }) };
    }
    if (url.endsWith("/ingest/bulk/load-status")) {
      if (state.opts.loadStatus === null) return { ok: false, status: 502, json: async () => ({}) };
      const ls = state.opts.loadStatus ?? { throttled: false, recent_429_count: 0, headroom_pct: 1, in_flight: 100, high_water: 8000 };
      return { ok: true, json: async () => ({
        pool_size: 32, connected: 32,
        dispatcher: { in_flight: ls.in_flight ?? 100, high_water: ls.high_water ?? 8000 },
        body_drain_errors: 0, workers: [{ id: 0, queued: 0, flushed: 4000, errors: 0, retries: 0, dead_lettered: 0, last_flush_latency_ms: 1 }],
        throttled: ls.throttled, headroom_pct: ls.headroom_pct, recent_429_count: ls.recent_429_count,
      }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, setLoadStatus: (next: MockOpts["loadStatus"]) => { state.opts.loadStatus = next; } };
}

function renderPanel() {
  window.history.pushState({}, "", "/");
  return render(
    <MemoryRouter>
      <GeneratorRunProvider>
        <IngestPanel />
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
}

async function startBulkRun() {
  await screen.findByTestId("ingest-preset-start-btn");
  fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
}

describe("IngestPanel — Wave 7.0.6.21 three-lane bulk-ingest layout", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders Generation (PhaseProgress) + Ingest (RateGauge) + Indexing (PhaseProgress)", async () => {
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 3000, loadStatus: { throttled: false, recent_429_count: 0, headroom_pct: 1, in_flight: 100, high_water: 8000 } });
    renderPanel();
    await startBulkRun();
    await waitFor(() => expect(screen.getByTestId("bulk-progress")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByTestId("phase-progress-generation")).toBeInTheDocument();
    expect(screen.getByTestId("rate-gauge-ingest")).toBeInTheDocument();
    expect(screen.getByTestId("phase-progress-indexing")).toBeInTheDocument();
    // Rate gauge is the only middle-lane testid; the legacy ingest PhaseProgress is gone.
    expect(screen.queryByTestId("phase-progress-ingest")).toBeNull();
  });

  it("indexing lane uses generated (rows_sent) as denominator, not requested (rows_total)", async () => {
    // indexed < generated < requested  ⇒  bar reads 3,000 / 5,000 (not / 10,000).
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 3000, loadStatus: { throttled: false, recent_429_count: 0, headroom_pct: 1, in_flight: 0, high_water: 8000 } });
    renderPanel();
    await startBulkRun();
    // Wait for the poll tick to propagate the run.rows_sent + indexCount
    // values into the bar text (initial render uses 0/0 until /ingest/bulk
    // and /admin/index-count complete their first round).
    await waitFor(
      () => {
        const text = screen.getByTestId("phase-progress-indexing-text").textContent ?? "";
        expect(text).toMatch(/3,000\s*\/\s*5,000\s*indexed/);
      },
      { timeout: 4000 },
    );
    const text = screen.getByTestId("phase-progress-indexing-text").textContent ?? "";
    expect(text).not.toMatch(/10,000/);
  });

  it("throttled load-status renders the red THROTTLED chip", async () => {
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 0, loadStatus: { throttled: true, recent_429_count: 15, headroom_pct: 0.05, in_flight: 7600, high_water: 8000 } });
    renderPanel();
    await startBulkRun();
    await waitFor(() => expect(screen.getByTestId("rate-gauge-ingest-chip")).toBeInTheDocument(), { timeout: 4000 });
    const chip = screen.getByTestId("rate-gauge-ingest-chip");
    expect(chip.getAttribute("data-state")).toBe("throttled");
    expect(chip.textContent).toMatch(/THROTTLED · 15 429\/10s/);
  });

  it("recovery state (throttled=false, recent_429>0) renders the amber chip", async () => {
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 0, loadStatus: { throttled: false, recent_429_count: 5, headroom_pct: 0.6, in_flight: 3000, high_water: 8000 } });
    renderPanel();
    await startBulkRun();
    await waitFor(() => expect(screen.getByTestId("rate-gauge-ingest-chip")).toBeInTheDocument(), { timeout: 4000 });
    const chip = screen.getByTestId("rate-gauge-ingest-chip");
    expect(chip.getAttribute("data-state")).toBe("recovering");
  });

  it("idle state (throttled=false, recent_429=0) renders no chip", async () => {
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 0, loadStatus: { throttled: false, recent_429_count: 0, headroom_pct: 1, in_flight: 0, high_water: 8000 } });
    renderPanel();
    await startBulkRun();
    await waitFor(() => expect(screen.getByTestId("rate-gauge-ingest")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByTestId("rate-gauge-ingest-chip")).toBeNull();
  });

  it("graceful degrade when /load/status fails: rate-gauge renders, no chip, no console errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => { /* noop */ });
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 0, loadStatus: null });
    renderPanel();
    await startBulkRun();
    await waitFor(() => expect(screen.getByTestId("rate-gauge-ingest")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByTestId("rate-gauge-ingest-chip")).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
