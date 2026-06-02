// Wave 5.38c — Flush DB button + /admin/flush wiring in IngestPanel.

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
  flushOk?: boolean;
  flushBody?: unknown;
  flushStatus?: number;
}

function mockFetch(opts: FetchOpts = {}) {
  const { flushOk = true, flushBody = { ok: true, ms: 7, target_label: "redis-primary" }, flushStatus = 200 } = opts;
  const fetchMock = vi.fn();
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse() };
    if (url.endsWith("/admin/flush") && method === "POST") {
      return { ok: flushOk, status: flushStatus, json: async () => flushBody };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — Flush DB button (Wave 5.38c)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders a destructive-styled 'Flush DB' button", async () => {
    fetchMock = mockFetch();
    renderPanel();
    const btn = await screen.findByTestId("flush-db-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/flush db/i);
    expect(btn.className).toMatch(/btn--danger/);
  });

  it("clicking Flush DB opens the confirmation modal (no POST yet)", async () => {
    fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("flush-db-btn"));
    const modal = await screen.findByTestId("flush-db-modal");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByRole("heading", { name: /flush the active redis database/i })).toBeInTheDocument();
    expect(within(modal).getByText(/will delete all sensitivities/i)).toBeInTheDocument();
    const posted = fetchMock.mock.calls.find(
      (c) => /\/admin\/flush$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("clicking Cancel closes the modal without POSTing", async () => {
    fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("flush-db-btn"));
    const modal = await screen.findByTestId("flush-db-modal");
    fireEvent.click(within(modal).getByTestId("flush-db-cancel"));
    await waitFor(() => expect(screen.queryByTestId("flush-db-modal")).not.toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      (c) => /\/admin\/flush$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("clicking Confirm POSTs to /admin/flush and shows the success banner", async () => {
    fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("flush-db-btn"));
    const modal = await screen.findByTestId("flush-db-modal");
    fireEvent.click(within(modal).getByTestId("flush-db-confirm"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/admin\/flush$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const banner = await screen.findByTestId("flush-db-banner");
    expect(banner).toHaveTextContent(/flushed in 7ms/i);
  });

  it("surfaces a flush error in the telemetry error display", async () => {
    fetchMock = mockFetch({ flushOk: false, flushStatus: 503, flushBody: { error: "no active target" } });
    renderPanel();
    fireEvent.click(await screen.findByTestId("flush-db-btn"));
    fireEvent.click(within(await screen.findByTestId("flush-db-modal")).getByTestId("flush-db-confirm"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/flush failed/i);
    expect(alert.textContent).toMatch(/no active target/i);
  });
});
