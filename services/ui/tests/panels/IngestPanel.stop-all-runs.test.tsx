// Wave 5.44 — Stop all runs button + /admin/cancel-all-runs wiring in
// IngestPanel. Mirrors the 5.38c flush-db test layout.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

function renderPanel() {
  return render(
    <MemoryRouter>
      <GeneratorRunProvider>
        <IngestPanel />
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
}

function keysResponse(dbsize: number) {
  return { prefix: "sens:", dbsize, sample: [], sample_size: 0, ms: 1 };
}
function memoryResponse() {
  return { used_memory: 0, used_memory_human: "0B", ms: 1 };
}

interface FetchOpts {
  cancelled?: number;
  run_ids?: string[];
  // Wave 6.44.E — proxy-to-ingest summary. `null` simulates the ingest-down
  // path so the partial-success banner can be asserted; the default value
  // mirrors a real successful flush.
  flush?: { ok: true; streams_trimmed: number; docs_cleared: number; elapsed_ms?: number } | null;
}

function mockFetch(opts: FetchOpts = {}) {
  const {
    cancelled = 2,
    run_ids = ["run-A", "run-B"],
    flush = { ok: true as const, streams_trimmed: 4, docs_cleared: 12, elapsed_ms: 7 },
  } = opts;
  const fetchMock = vi.fn();
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse() };
    if (url.endsWith("/admin/cancel-all-runs") && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, cancelled, run_ids, flush }) };
    }
    if (url.endsWith("/generator/runs") && method === "GET") {
      return { ok: true, json: async () => ({ active: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — Stop all runs button (Wave 5.44)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders a danger-styled 'Stop all runs' button alongside Flush DB", async () => {
    fetchMock = mockFetch();
    renderPanel();
    const btn = await screen.findByTestId("stop-all-runs-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/stop all runs/i);
    expect(btn.className).toMatch(/btn--danger/);
    // Coexistence with the existing Flush DB button.
    expect(await screen.findByTestId("flush-db-btn")).toBeInTheDocument();
  });

  it("clicking the button opens the confirm modal — no POST yet", async () => {
    fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    const modal = await screen.findByTestId("stop-all-runs-modal");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByRole("heading", { name: /stop all active generator runs/i })).toBeInTheDocument();
    // Wave 6.44.E — modal copy now warns about the destructive flush
    // (stream backlog + indexed-row wipe) so the operator can't mistake
    // this for a soft cancel.
    expect(within(modal).getByText(/wipes the stream backlog/i)).toBeInTheDocument();
    expect(within(modal).getByText(/indexed rows/i)).toBeInTheDocument();
    const posted = fetchMock.mock.calls.find(
      (c) => /\/admin\/cancel-all-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("clicking Cancel in the modal closes it without POSTing", async () => {
    fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    const modal = await screen.findByTestId("stop-all-runs-modal");
    fireEvent.click(within(modal).getByTestId("stop-all-runs-cancel"));
    await waitFor(() => expect(screen.queryByTestId("stop-all-runs-modal")).not.toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      (c) => /\/admin\/cancel-all-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("Confirm POSTs /admin/cancel-all-runs and shows a banner with the cancelled count", async () => {
    fetchMock = mockFetch({ cancelled: 2, run_ids: ["run-A", "run-B"] });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/admin\/cancel-all-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/stopped 2 runs/i);
    // Wave 6.44.E — banner now also surfaces the flush summary from the
    // proxy-to-ingest call so the user sees both halves of the action.
    expect(banner).toHaveTextContent(/flushed 4 streams/i);
    expect(banner).toHaveTextContent(/cleared 12 indexed rows/i);
  });

  it("banner reads 'No active runs' when the server reports cancelled:0", async () => {
    fetchMock = mockFetch({ cancelled: 0, run_ids: [] });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/no active runs/i);
    // The flush still runs even when there were no live runs — DoD #2.
    expect(banner).toHaveTextContent(/flushed 4 streams/i);
  });

  // Wave 6.44.E DoD #4 — ingest-down partial success: the cancel still
  // succeeds, the banner switches to the partial-success copy, and the
  // panel does NOT raise an error.
  it("banner reports 'ingest unreachable' when the server returns flush:null", async () => {
    fetchMock = mockFetch({ cancelled: 1, run_ids: ["run-X"], flush: null });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/stopped 1 run/i);
    expect(banner).toHaveTextContent(/ingest unreachable/i);
  });
});
