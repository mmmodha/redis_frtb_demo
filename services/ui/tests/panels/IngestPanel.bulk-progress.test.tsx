// Wave 7.0.8 — IngestPanel bulk-ingest progress (single bar, Docker UX).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import { GeneratorRunProvider } from "../../src/context/GeneratorRunContext";
import { BulkIngestRunProvider } from "../../src/context/BulkIngestRunContext";

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

function mockFetch(opts: { rowsSent?: number; rowsTotal?: number; indexCount?: number; throttled?: boolean; recent429?: number }) {
  const state = { ...opts };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources")) return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => ({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 1 }) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => ({ used_memory: 0, used_memory_human: "0B", ms: 1 }) };
    if (url.includes("/admin/index-count")) return { ok: true, json: async () => ({ count: state.indexCount ?? 0, index_name: "idx:sens:v1" }) };
    if (url.endsWith("/admin/host-info")) return { ok: true, json: async () => ({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null }) };
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => preflightPass };
    if (url.endsWith("/ingest/shards")) return { ok: true, json: async () => ({ totalShards: 1 }) };
    if (url.endsWith("/ingest/bulk/runs")) return { ok: true, json: async () => ({ active: [] }) };
    if (url.endsWith("/ingest/bulk/start") && method === "POST") {
      const body = JSON.parse(String((init as any).body));
      return { ok: true, json: async () => ({
        ok: true, run_id: "01RUN", rows_total: body.rows,
        batch_size: 500, concurrency: 32, workers: body.workers ?? 8,
        bulk_loader_base: "http://bl:8086", started_at_iso: new Date().toISOString(),
      }) };
    }
    if (url.includes("/ingest/bulk/runs/")) {
      return { ok: true, json: async () => ({
        run_id: "01RUN", status: "running",
        rows_total: state.rowsTotal ?? 10000,
        rows_sent: state.rowsSent ?? 5000,
        rows_skipped: 0, batch_size: 500, concurrency: 32, workers: 8,
        ms: 1000, started_at_iso: new Date().toISOString(),
        bulk_loader_base: "http://bl:8086", rows_per_sec: 5000,
        throttled: state.throttled ?? false,
      }) };
    }
    if (url.endsWith("/ingest/bulk/load-status")) {
      return { ok: true, json: async () => ({
        pool_size: 32, connected: 32,
        dispatcher: { in_flight: 100, high_water: 8000 },
        body_drain_errors: 0,
        workers: [{ id: 0, queued: 0, flushed: 4000, errors: 0, retries: 0, dead_lettered: 0, last_flush_latency_ms: 1 }],
        throttled: state.throttled ?? false,
        headroom_pct: 1,
        recent_429_count: state.recent429 ?? 0,
      }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

function renderPanel() {
  window.history.pushState({}, "", "/");
  return render(
    <MemoryRouter>
      <GeneratorRunProvider>
        <BulkIngestRunProvider>
          <IngestPanel />
        </BulkIngestRunProvider>
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
}

describe("IngestPanel — Wave 7.0.8 single bulk-ingest progress bar", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders one Rows ingested progress bar (not three lanes)", async () => {
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 3000 });
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    await waitFor(() => expect(screen.getByTestId("bulk-progress")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByTestId("phase-progress-ingest")).toBeInTheDocument();
    expect(screen.queryByTestId("phase-progress-generation")).toBeNull();
    expect(screen.queryByTestId("rate-gauge-ingest")).toBeNull();
    expect(screen.queryByTestId("phase-progress-indexing")).toBeNull();
  });

  it("progress uses run-scoped rows_sent, not pre-existing index count", async () => {
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 1_000_000 });
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-start-btn"));
    await waitFor(() => {
      const text = screen.getByTestId("phase-progress-ingest-text").textContent ?? "";
      expect(text).toMatch(/5,000\s*\/\s*10,000/);
    }, { timeout: 4000 });
  });

  it("shows backpressure hint when throttled and run is not complete", async () => {
    mockFetch({ rowsSent: 5000, rowsTotal: 10000, indexCount: 0, throttled: true, recent429: 12 });
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-start-btn"));
    const hint = await screen.findByTestId("bulk-progress-throttle", {}, { timeout: 4000 });
    expect(hint).toHaveClass("bulk-progress__hint");
    expect(hint).toHaveTextContent(/Redis is catching up/i);
    expect(hint).toHaveTextContent(/What to do:/i);
    expect(hint).not.toHaveTextContent(/429/);
  });
});
