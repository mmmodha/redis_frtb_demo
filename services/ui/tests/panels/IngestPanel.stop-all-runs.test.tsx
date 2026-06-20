// Wave 5.44 / 6.53.A — Stop generators button + /admin/stop-runs wiring in
// IngestPanel. Mirrors the 5.38c flush-db test layout. Wave 6.53.A
// decoupled this from the destructive halt-and-flush: the button now hits
// the non-destructive /admin/stop-runs route and the banner no longer
// surfaces a flush summary. Use "Flush DB" for the destructive path.

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
}

function mockFetch(opts: FetchOpts = {}) {
  const {
    cancelled = 2,
    run_ids = ["run-A", "run-B"],
  } = opts;
  const fetchMock = vi.fn();
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse() };
    if (url.endsWith("/admin/stop-runs") && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, cancelled, run_ids }) };
    }
    if (url.endsWith("/generator/runs") && method === "GET") {
      return { ok: true, json: async () => ({ active: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — Stop generators button (Wave 5.44 / 6.53.A)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders a danger-styled 'Stop generators' button alongside Flush DB", async () => {
    fetchMock = mockFetch();
    renderPanel();
    const btn = await screen.findByTestId("stop-all-runs-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/stop generators/i);
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
    expect(within(modal).getByRole("heading", { name: /stop active generators/i })).toBeInTheDocument();
    // Wave 6.53.A — modal copy makes it explicit that data + stream backlog
    // are kept and points users at "Flush DB" for the destructive path.
    expect(within(modal).getByText(/data and stream backlog are kept/i)).toBeInTheDocument();
    expect(within(modal).getByText(/flush db/i)).toBeInTheDocument();
    const posted = fetchMock.mock.calls.find(
      (c) => /\/admin\/stop-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
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
      (c) => /\/admin\/stop-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("Confirm POSTs /admin/stop-runs and shows a banner with the cancelled count (no flush summary)", async () => {
    fetchMock = mockFetch({ cancelled: 2, run_ids: ["run-A", "run-B"] });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/admin\/stop-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    // Wave 6.53.A — the legacy /admin/cancel-all-runs route stays wired on
    // the api for backward compat but the UI must no longer hit it.
    const legacyPosted = fetchMock.mock.calls.find(
      (c) => /\/admin\/cancel-all-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(legacyPosted).toBeUndefined();
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/stopped 2 generators/i);
    // Wave 6.53.A — the banner no longer surfaces a flush summary; the
    // destructive path lives behind the dedicated "Flush DB" button.
    expect(banner.textContent ?? "").not.toMatch(/flushed/i);
    expect(banner.textContent ?? "").not.toMatch(/indexed rows/i);
  });

  it("banner reads 'No active runs' when the server reports cancelled:0", async () => {
    fetchMock = mockFetch({ cancelled: 0, run_ids: [] });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/no active runs/i);
    // No flush summary even on the empty-runs banner.
    expect(banner.textContent ?? "").not.toMatch(/flushed/i);
  });
});
