import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../src/panels/IngestPanel";

vi.mock("../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card" data-title={title}>
      <header>
        <h2>{title}</h2>
        {actions}
      </header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: any) => (
    <aside data-testid="enterprise-callout" data-signal={signal}>
      <span>buying signal: {signal}</span>
      {children}
    </aside>
  ),
}));
vi.mock("../src/components/MetricTile", () => ({
  MetricTile: ({ label, value, unit, status }: any) => (
    <div data-testid="metric-tile" data-label={label} data-status={status}>
      <span className="label">{label}</span>
      <strong className="value">{value}</strong>
      {unit ? <span className="unit">{unit}</span> : null}
      {status ? <span className="status">{status}</span> : null}
    </div>
  ),
}));

function renderPanel() {
  return render(
    <MemoryRouter>
      <IngestPanel />
    </MemoryRouter>,
  );
}

function keysResponse(dbsize: number, sample: string[] = []) {
  return { prefix: "sens:", dbsize, sample, sample_size: sample.length, ms: 1 };
}
function memoryResponse(used_memory: number) {
  return { used_memory, used_memory_human: `${used_memory}B`, ms: 1 };
}

describe("IngestPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the Ingest heading and Streams + JSON EnterpriseCallout banners", () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => keysResponse(0) });
    renderPanel();
    expect(screen.getByRole("heading", { name: /^Ingest$/i, level: 1 })).toBeInTheDocument();
    const callouts = screen.getAllByTestId("enterprise-callout");
    const signals = callouts.map((c) => c.getAttribute("data-signal"));
    expect(signals).toContain("Streams");
    expect(signals).toContain("JSON");
  });

  it("polls GET /observability/keys?prefix=sens: and GET /observability/memory on mount", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(100, ["sens:{GIRR:USD-IRS}:01HXAA"]) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(1048576) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /\/observability\/keys\?prefix=sens:/.test(u))).toBe(true);
    expect(urls.some((u) => /\/observability\/memory/.test(u))).toBe(true);
  });

  it("shows an empty state when dbsize is 0 and no samples", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/no rows ingested yet/i)).toBeInTheDocument());
  });

  it("shows an error state when /observability/keys fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/observability/keys")) return { ok: false, status: 500, json: async () => ({}) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/failed to load ingest telemetry/i)).toBeInTheDocument());
  });

  it("renders MetricTiles for Total rows, Rows/sec and Memory", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(5000) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(2 * 1024 * 1024) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId("metric-tile").length).toBeGreaterThanOrEqual(3));
    const labels = screen.getAllByTestId("metric-tile").map((el) => el.getAttribute("data-label"));
    expect(labels).toEqual(expect.arrayContaining(["Total rows", "Rows/sec", "Memory"]));
  });

  it("renders the literal sens:{risk_class:bucket}:{ulid} keys in the Sample keys panel", async () => {
    const samples = [
      "sens:{GIRR:USD-IRS}:01HXAA",
      "sens:{GIRR:EUR-IRS}:01HXBB",
      "sens:{Equity:B1}:01HXCC",
    ];
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(3, samples) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    const samplePanel = await waitFor(() => screen.getByTestId("panel-card-sample-keys"));
    for (const k of samples) {
      expect(within(samplePanel).getByText(k)).toBeInTheDocument();
    }
  });

  it("renders an SVG throughput chart and an SVG memory chart in their PanelCards", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(100) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(1024) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("chart-throughput")).toBeInTheDocument();
      expect(screen.getByTestId("chart-memory")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chart-throughput").tagName.toLowerCase()).toBe("svg");
    expect(screen.getByTestId("chart-memory").tagName.toLowerCase()).toBe("svg");
  });

  it("Start Ingest button POSTs /sources/:id/ingest with the active source id", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sources") && method === "GET")
        return { ok: true, json: async () => [{ id: "src-1", kind: "synthetic", is_active: true }] };
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
      if (/\/sources\/src-1\/ingest$/.test(url) && method === "POST")
        return { ok: true, json: async () => ({ ok: true, run_id: "r1" }) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    const startBtn = await waitFor(() => screen.getByRole("button", { name: /start ingest/i }));
    fireEvent.click(startBtn);
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/sources\/src-1\/ingest$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
  });

  it("falls back to the generator button when /sources is empty (404 or empty list)", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sources") && method === "GET")
        return { ok: true, json: async () => [] };
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
      if (url.endsWith("/generator/start") && method === "POST")
        return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    const fallback = await waitFor(() => screen.getByRole("button", { name: /run generator/i }));
    fireEvent.click(fallback);
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
  });
});
