// Wave 7.0.6.15 / 7.0.8 — IngestPanel workers control on the preset surface.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { IngestPanel, suggestWorkersForPreset } from "../../src/panels/IngestPanel";
import { renderIngestPanelOnly } from "./ingestPanelTestHelpers";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2>{actions}</header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/MetricTile", () => ({
  MetricTile: ({ label, value }: { label: string; value: string | number }) => (
    <div data-label={label}>{value}</div>
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

function mockFetch(hostInfo: Record<string, unknown> | null) {
  const bulkStartCalls: Array<{ body: { workers?: number; rows: number } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => preflightPass };
    if (url.includes("/observability/memory")) {
      return { ok: true, json: async () => ({ used_memory_human: "0B" }) };
    }
    if (url.endsWith("/admin/index-count")) {
      return { ok: true, json: async () => ({ count: 0, index_name: "sens:", refreshing: false }) };
    }
    if (url.endsWith("/admin/host-info")) {
      if (hostInfo === null) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => hostInfo };
    }
    if (url.endsWith("/ingest/bulk/start") && method === "POST") {
      const body = JSON.parse(String((init as { body?: string }).body));
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
    if (url.endsWith("/ingest/snapshot")) {
      return { ok: true, json: async () => ({
        ok: true, target_label: "local",
        cluster: { sens_count: 0, sens_count_refreshing: false, memory_bytes: 0, memory_human: "0B" },
        loader: { in_flight: 0, flush_rps: 0, flushed_total: 0, throttled: false, recent_429_count: 0 },
        runs: [{
          run_id: "01RUN", status: "running", rows_total: 10_000,
          rows_sent: 0, rows_written: 0, rows_per_sec_producer: 0, rows_per_sec_write: 0,
          phase: "producing", workers: 2, started_at_iso: new Date().toISOString(),
        }],
        focused_run_id: "01RUN",
      }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  return { bulkStartCalls };
}

function renderPanel() {
  window.history.pushState({}, "", "/");
  return renderIngestPanelOnly();
}

describe("IngestPanel — workers control (preset surface)", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("suggestWorkersForPreset scales workers for 1M and 10M presets", () => {
    expect(suggestWorkersForPreset("medium")).toBe(4);
    expect(suggestWorkersForPreset("large")).toBe(6);
  });

  it("renders workers on the preset card with Docker-friendly default", async () => {
    mockFetch({
      cores: 8,
      recommended_max_workers: 6,
      max_workers_hard_cap: 32,
      bulk_loader_pool_size: 32,
      bulk_loader_replicas: 4,
      shards: null,
      target_label: "local",
    });
    renderPanel();
    expect(await screen.findByTestId("ingest-workers-value")).toHaveTextContent("2");
  });

  it("updates workers when a larger preset is selected", async () => {
    mockFetch({
      cores: 8,
      recommended_max_workers: 8,
      max_workers_hard_cap: 32,
      bulk_loader_pool_size: 32,
      bulk_loader_replicas: 4,
      shards: null,
      target_label: "local",
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-large"));
    await waitFor(() => {
      expect(screen.getByTestId("ingest-workers-value")).toHaveTextContent("6");
    });
  });

  it("posts the chosen workers value to /ingest/bulk/start", async () => {
    const { bulkStartCalls } = mockFetch({
      cores: 8,
      recommended_max_workers: 8,
      max_workers_hard_cap: 32,
      bulk_loader_pool_size: 32,
      bulk_loader_replicas: 4,
      shards: null,
      target_label: "local",
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-preset-start-btn"));
    await waitFor(() => expect(bulkStartCalls.length).toBe(1));
    expect(bulkStartCalls[0]!.body.workers).toBe(2);
    expect(bulkStartCalls[0]!.body.rows).toBe(10_000);
  });
});
