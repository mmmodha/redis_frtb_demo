// Wave 6.12b — IngestPanel fan-out card: producer-match indicator,
// POST /ingest/shards wiring, and 400/409 error surfacing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import {
  GeneratorRunContext,
  type GeneratorRunContextValue,
  type GeneratorRunState,
} from "../../src/context/GeneratorRunContext";

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

function fakeCtx(run: GeneratorRunState | null): GeneratorRunContextValue {
  return { run, error: null, startRun: () => {}, cancelRun: () => {}, clearRun: () => {} };
}

function renderPanel(run: GeneratorRunState | null) {
  return render(
    <MemoryRouter>
      <GeneratorRunContext.Provider value={fakeCtx(run)}>
        <IngestPanel />
      </GeneratorRunContext.Provider>
    </MemoryRouter>,
  );
}

function runningRun(runId: string): GeneratorRunState {
  return { runId, rowsTotal: 1000, rowsDone: 10, elapsedMs: 1, rowsPerSec: 0, status: "running" };
}

interface FetchOpts {
  ingestShards?: number;
  producerStreamShards?: number | "per-bucket" | undefined;
  postStatus?: number;
  postBody?: unknown;
  postResultShards?: number;
}

function mockFetch(opts: FetchOpts = {}) {
  const { ingestShards = 1, producerStreamShards, postStatus, postBody, postResultShards } = opts;
  let currentIngest = ingestShards;
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => ({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 1 }) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => ({ used_memory: 0, used_memory_human: "0B", ms: 1 }) };
    if (url.endsWith("/admin/preflight")) return { ok: true, json: async () => ({ ok: true, checks: { idx_sens: { ok: true, missing: [] }, frtb_library: { ok: true, loaded: true }, stream: { ok: true, exists: true } }, can_rebuild: false }) };
    if (url.endsWith("/ingest/shards") && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ totalShards: currentIngest }) };
    }
    if (url.endsWith("/ingest/shards") && method === "POST") {
      if (postStatus && postStatus >= 400) {
        return { ok: false, status: postStatus, json: async () => postBody ?? { error: "boom" } };
      }
      if (postResultShards !== undefined) currentIngest = postResultShards;
      return { ok: true, status: 200, json: async () => ({ totalShards: currentIngest }) };
    }
    if (/\/generator\/runs\/.+\/status$/.test(url) && method === "GET") {
      const dials = producerStreamShards !== undefined
        ? { dials: { workers: 1, batch_size: 1, pipeline_window: 1, stream_shards: producerStreamShards } }
        : {};
      return { ok: true, json: async () => ({ run_id: "r1", status: "running", rows_done: 0, rows_total: 1000, rows_per_sec: 0, elapsed_ms: 1, ...dials }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — fan-out card (Wave 6.12b)", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders the card and shows current ingest fan-out from GET /ingest/shards", async () => {
    mockFetch({ ingestShards: 8 });
    renderPanel(null);
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-card")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-ingest").textContent).toMatch(/8/));
    // No active run ⇒ producer fan-out is em-dash and chip is neutral.
    expect(screen.getByTestId("ingest-fanout-producer").textContent).toMatch(/—/);
    expect(screen.getByTestId("ingest-fanout-chip-neutral")).toBeInTheDocument();
  });

  it("mismatch chip + explainer when producer=16, ingest=1", async () => {
    mockFetch({ ingestShards: 1, producerStreamShards: 16 });
    renderPanel(runningRun("r1"));
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-chip-mismatch")).toBeInTheDocument());
    expect(screen.getByTestId("ingest-fanout-producer").textContent).toMatch(/16/);
    expect(screen.getByTestId("ingest-fanout-explainer")).toBeInTheDocument();
  });

  it("match chip when producer=16, ingest=16", async () => {
    mockFetch({ ingestShards: 16, producerStreamShards: 16 });
    renderPanel(runningRun("r1"));
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-chip-match")).toBeInTheDocument());
    expect(screen.getByTestId("ingest-fanout-ingest").textContent).toMatch(/16/);
    expect(screen.queryByTestId("ingest-fanout-explainer")).not.toBeInTheDocument();
  });

  it("Apply posts to /ingest/shards and refreshes the displayed value", async () => {
    const fetchMock = mockFetch({ ingestShards: 1, postResultShards: 16 });
    renderPanel(null);
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-ingest").textContent).toMatch(/1/));
    fireEvent.change(screen.getByTestId("ingest-fanout-select"), { target: { value: "16" } });
    fireEvent.click(screen.getByTestId("ingest-fanout-apply"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/ingest\/shards$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
      expect(JSON.parse((posted![1] as RequestInit).body as string)).toEqual({ totalShards: 16 });
    });
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-ingest").textContent).toMatch(/16/));
  });

  it("surfaces a 409 'rebuild already in progress' error inline", async () => {
    mockFetch({ ingestShards: 1, postStatus: 409, postBody: { error: "rebuild already in progress" } });
    renderPanel(null);
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-card")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("ingest-fanout-apply"));
    const err = await screen.findByTestId("ingest-fanout-error");
    expect(err.textContent).toMatch(/409/);
    expect(err.textContent).toMatch(/rebuild already in progress/);
  });

  it("surfaces a 400 'invalid' error inline", async () => {
    mockFetch({ ingestShards: 1, postStatus: 400, postBody: { error: "totalShards must be a positive integer" } });
    renderPanel(null);
    await waitFor(() => expect(screen.getByTestId("ingest-fanout-card")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("ingest-fanout-apply"));
    const err = await screen.findByTestId("ingest-fanout-error");
    expect(err.textContent).toMatch(/400/);
    expect(err.textContent).toMatch(/positive integer/);
  });
});
