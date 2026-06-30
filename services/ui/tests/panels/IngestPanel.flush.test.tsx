// Wave 5.38c — Flush DB button + /admin/flush wiring in IngestPanel.

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

function mockFetch(opts: { flushBody?: unknown; flushOk?: boolean } = {}) {
  const flushBody = opts.flushBody ?? { ok: true, ms: 7, target_label: "redis-primary", bootstrap: { ok: true } };
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/ingest/snapshot")) return { ok: true, json: async () => EMPTY_INGEST_SNAPSHOT };
    if (url.includes("/observability/memory")) {
      return { ok: true, json: async () => ({ used_memory_human: "0B" }) };
    }
    if (url.endsWith("/admin/index-count")) {
      return { ok: true, json: async () => ({ count: 0, index_name: "sens:", refreshing: false }) };
    }
    if (url.endsWith("/admin/host-info")) {
      return { ok: true, json: async () => ({ cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32, bulk_loader_pool_size: 32, bulk_loader_replicas: 1, shards: null, target_label: null }) };
    }
    if (url.endsWith("/admin/stop-runs") && method === "POST") {
      return { ok: true, json: async () => ({ ok: true, cancelled: 0, run_ids: [] }) };
    }
    if (url.endsWith("/admin/flush") && method === "POST") {
      return { ok: opts.flushOk ?? true, json: async () => flushBody };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — Flush DB button", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("renders Flush DB and opens confirm modal", async () => {
    mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("flush-db-btn"));
    expect(await screen.findByTestId("flush-db-modal")).toBeInTheDocument();
  });

  it("Confirm POSTs /admin/flush and shows success banner", async () => {
    const fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("flush-db-btn"));
    fireEvent.click(within(await screen.findByTestId("flush-db-modal")).getByTestId("flush-db-confirm"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/admin/flush"))).toBe(true);
    });
    expect(await screen.findByTestId("flush-db-banner")).toHaveTextContent(/flushed in 7ms/i);
  });
});
