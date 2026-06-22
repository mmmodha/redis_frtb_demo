// Wave 7.0.6.15 — IngestPanel workers slider + /admin/host-info hint.
//
// Covers the new bulk-loader worker_threads fan-out control:
//   - Workers input renders next to the Mode select, default value 1
//   - On mount, /admin/host-info is fetched and the hint line renders
//   - Clicking Start in bulk-loader mode POSTs the chosen `workers` value
//     to /ingest/bulk/start
//   - The slider is disabled in stream mode (legacy path stays single-consumer)

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

interface BulkStartCall { body: any }

function mockFetch(hostInfo: any | null) {
  const bulkStartCalls: BulkStartCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources")) return { ok: true, json: async () => [] };
    if (url.includes("/observability/")) return { ok: true, json: async () => ({}) };
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => preflightPass };
    if (url.endsWith("/admin/host-info")) {
      if (hostInfo === null) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => hostInfo };
    }
    if (url.endsWith("/ingest/bulk/start") && method === "POST") {
      const body = JSON.parse(String((init as any).body));
      bulkStartCalls.push({ body });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          run_id: "01RUN",
          rows_total: body.rows,
          batch_size: 500,
          concurrency: 32,
          workers: body.workers ?? 1,
          bulk_loader_base: "http://bl:8086",
          started_at_iso: new Date().toISOString(),
        }),
      };
    }
    if (url.includes("/ingest/bulk/runs/")) {
      return { ok: true, json: async () => ({
        run_id: "01RUN", status: "done", rows_total: 10000, rows_sent: 10000,
        rows_skipped: 0, batch_size: 500, concurrency: 32, workers: 1,
        ms: 100, started_at_iso: new Date().toISOString(),
        bulk_loader_base: "http://bl:8086", rows_per_sec: 100000,
      }) };
    }
    if (url.endsWith("/ingest/bulk/load-status")) {
      return { ok: true, json: async () => ({ pool_size: 32, connected: 32, dispatcher: null, body_drain_errors: 0, workers: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bulkStartCalls };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <GeneratorRunProvider>
        <IngestPanel />
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
}

describe("IngestPanel — Wave 7.0.6.15 workers slider", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("renders the workers input with default value 1", async () => {
    mockFetch({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null });
    renderPanel();
    const input = await screen.findByTestId("ingest-workers-input") as HTMLInputElement;
    expect(input).toBeDefined();
    // The slider defaults to 1 (single-worker bit-equivalent path).
    expect(input.value).toBe("1");
    expect(input.min).toBe("1");
  });

  it("renders the host hint with cores · pool · shards from /admin/host-info", async () => {
    mockFetch({ cores: 12, recommended_max_workers: 10, max_workers_hard_cap: 32, bulk_loader_pool_size: 48, shards: 4, target_label: "redis-primary" });
    renderPanel();
    const hint = await screen.findByTestId("ingest-workers-hint");
    await waitFor(() => expect(hint.textContent).toMatch(/12 cores/));
    expect(hint.textContent).toMatch(/pool 48/);
    expect(hint.textContent).toMatch(/shards 4/);
  });

  it("falls back to a usable hint when /admin/host-info errors", async () => {
    mockFetch(null);
    renderPanel();
    const hint = await screen.findByTestId("ingest-workers-hint");
    expect(hint.textContent).toMatch(/\? cores/);
    const input = await screen.findByTestId("ingest-workers-input") as HTMLInputElement;
    // Failsafe max=8 keeps the slider usable even when host-info is down.
    expect(input.max).toBe("8");
  });

  it("posts the chosen workers value to /ingest/bulk/start", async () => {
    const { bulkStartCalls } = mockFetch({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null });
    renderPanel();
    const input = await screen.findByTestId("ingest-workers-input") as HTMLInputElement;
    // Mode is "bulk-loader" by default in 7.0.6.13+. Change workers → 4
    // and click Start. The orchestrator should POST workers: 4.
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    await waitFor(() => expect(bulkStartCalls.length).toBeGreaterThan(0));
    expect(bulkStartCalls[0]!.body.workers).toBe(4);
  });

  it("disables the workers input in stream (legacy) mode", async () => {
    mockFetch({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null });
    renderPanel();
    const input = await screen.findByTestId("ingest-workers-input") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(screen.getByTestId("ingest-mode-select"), { target: { value: "stream" } });
    expect(input.disabled).toBe(true);
  });
});
