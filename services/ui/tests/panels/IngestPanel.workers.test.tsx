// Wave 7.0.6.15 / 7.0.8 — IngestPanel workers control on the preset surface.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel, suggestWorkersForPreset } from "../../src/panels/IngestPanel";
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

function mockFetch(hostInfo: any | null) {
  const bulkStartCalls: Array<{ body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources")) return { ok: true, json: async () => [] };
    if (url.includes("/observability/")) return { ok: true, json: async () => ({}) };
    if (url.includes("/admin/index-count")) return { ok: true, json: async () => ({ count: 0, index_name: null }) };
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => preflightPass };
    if (url.endsWith("/ingest/shards")) return { ok: true, json: async () => ({ totalShards: 1 }) };
    if (url.endsWith("/ingest/bulk/runs")) return { ok: true, json: async () => ({ active: [] }) };
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
          workers: body.workers ?? 8,
          bulk_loader_base: "http://bl:8086",
          started_at_iso: new Date().toISOString(),
        }),
      };
    }
    if (url.includes("/ingest/bulk/runs/")) {
      return { ok: true, json: async () => ({
        run_id: "01RUN", status: "done", rows_total: 10000, rows_sent: 10000,
        rows_skipped: 0, batch_size: 500, concurrency: 32, workers: 8,
        ms: 100, started_at_iso: new Date().toISOString(),
        bulk_loader_base: "http://bl:8086", rows_per_sec: 100000,
      }) };
    }
    if (url.endsWith("/ingest/bulk/load-status")) {
      return { ok: true, json: async () => ({ pool_size: 32, connected: 32, dispatcher: null, body_drain_errors: 0, workers: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  return { bulkStartCalls };
}

function renderPanel(opts?: { stream?: boolean }) {
  if (opts?.stream) window.history.pushState({}, "", "/?ingestMode=stream");
  else window.history.pushState({}, "", "/");
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

async function findWorkersInput() {
  return screen.findByTestId("ingest-workers-value") as Promise<HTMLElement>;
}

describe("IngestPanel — workers control (preset surface)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("suggestWorkersForPreset scales workers for 1M and 10M presets", () => {
    expect(suggestWorkersForPreset("medium")).toBe(4);
    expect(suggestWorkersForPreset("large")).toBe(6);
  });

  it("renders workers on the preset card with Docker-friendly default", async () => {
    mockFetch({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null });
    renderPanel();
    const value = await findWorkersInput();
    await waitFor(() => expect(value.textContent).toBe("4"));
    const dec = screen.getByTestId("ingest-workers-dec") as HTMLButtonElement;
    const inc = screen.getByTestId("ingest-workers-inc") as HTMLButtonElement;
    expect(dec.disabled).toBe(false);
    expect(inc.disabled).toBe(false);
  });

  it("renders host hint from /admin/host-info", async () => {
    mockFetch({ cores: 12, recommended_max_workers: 10, max_workers_hard_cap: 32, bulk_loader_pool_size: 48, shards: 4, target_label: "redis-primary" });
    renderPanel();
    await findWorkersInput();
    const hint = await screen.findByTestId("ingest-workers-hint");
    expect(hint.textContent).toMatch(/12 cores/);
    expect(hint.textContent).toMatch(/pool 48/);
    expect(hint.textContent).toMatch(/recommended/i);
  });

  it("updates workers when a larger preset is selected", async () => {
    mockFetch({ cores: 8, recommended_max_workers: 8, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null });
    renderPanel();
    const value = await findWorkersInput();
    fireEvent.click(screen.getByTestId("ingest-preset-large"));
    await waitFor(() => expect(value.textContent).toBe("6"));
  });

  it("posts the chosen workers value to /ingest/bulk/start", async () => {
    const { bulkStartCalls } = mockFetch({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, shards: null, target_label: null });
    renderPanel();
    await findWorkersInput();
    fireEvent.click(screen.getByTestId("ingest-workers-dec"));
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    await waitFor(() => expect(bulkStartCalls.length).toBeGreaterThan(0));
    expect(bulkStartCalls[0]!.body.workers).toBe(3);
  });
});
