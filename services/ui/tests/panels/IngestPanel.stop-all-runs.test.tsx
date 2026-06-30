// Stop all runs button wiring in the bulk-loader-first IngestPanel.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { EMPTY_INGEST_SNAPSHOT } from "../helpers/ingest-snapshot-fixture";
import { renderIngestPanel } from "./ingestPanelTestHelpers";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2></header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/MetricTile", () => ({
  MetricTile: ({ label, value }: { label: string; value: string | number }) => (
    <div data-label={label}>{value}</div>
  ),
}));

function renderPanel() {
  return renderIngestPanel();
}

function mockFetch(opts: { bulk_cancelled?: number } = {}) {
  const bulk_cancelled = opts.bulk_cancelled ?? 2;
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/observability/memory")) {
      return { ok: true, json: async () => ({ used_memory_human: "0B" }) };
    }
    if (url.endsWith("/admin/index-count")) {
      return { ok: true, json: async () => ({ count: 0, index_name: "sens:", refreshing: false }) };
    }
    if (url.endsWith("/admin/host-info")) {
      return { ok: true, json: async () => ({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 16, bulk_loader_replicas: 1, shards: null, target_label: null }) };
    }
    if (url.endsWith("/admin/stop-runs") && method === "POST") {
      return { ok: true, json: async () => ({ ok: true, cancelled: 0, run_ids: [], bulk_cancelled, bulk_run_ids: ["a", "b"] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — Stop all button", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("renders Stop all alongside Flush DB", async () => {
    mockFetch();
    renderPanel();
    expect(await screen.findByTestId("stop-all-runs-btn")).toHaveTextContent(/stop all/i);
    expect(screen.getByTestId("flush-db-btn")).toBeInTheDocument();
  });

  it("Confirm POSTs /admin/stop-runs and shows bulk cancel banner", async () => {
    const fetchMock = mockFetch({ bulk_cancelled: 2 });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/admin/stop-runs"))).toBe(true);
    });
    expect(await screen.findByTestId("stop-all-runs-banner")).toHaveTextContent(/2 bulk ingest runs/i);
  });
});
