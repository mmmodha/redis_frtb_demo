import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PivotPanel } from "../src/panels/PivotPanel";

// Shell components (owned by task 1) are mocked so this unit test runs in
// isolation. Production composition is asserted by the Playwright e2e suite.
vi.mock("../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card">
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
    <aside data-testid="enterprise-callout" data-signal={signal}>{children}</aside>
  ),
}));
vi.mock("../src/components/MetricTile", () => ({
  MetricTile: ({ label, value, unit }: any) => (
    <div data-testid="metric-tile" data-label={label}>
      <span>{label}</span>
      <strong>{value}</strong>
      <span>{unit}</span>
    </div>
  ),
}));

function renderPanel() {
  return render(
    <MemoryRouter>
      <PivotPanel />
    </MemoryRouter>
  );
}

function pivotResponse(over: Partial<{ total: number; ms: number; rows: any[] }> = {}) {
  return {
    total: over.total ?? 2,
    limit: 100,
    offset: 0,
    ms: over.ms ?? 12.345,
    rows: over.rows ?? [
      {
        key: "sens:{GIRR:USD-IRS}:01HXAA",
        doc: {
          risk_class: "GIRR",
          bucket: "USD-IRS",
          sensitivity_type: "Delta",
          book: "RATES-LDN",
          risk_value: [0.1, 0.2],
          trade_id: "T-1",
        },
      },
      {
        key: "sens:{GIRR:USD-IRS}:01HXBB",
        doc: {
          risk_class: "GIRR",
          bucket: "USD-IRS",
          sensitivity_type: "Delta",
          book: "RATES-LDN",
          risk_value: [0.3],
          trade_id: "T-2",
        },
      },
    ],
  };
}

describe("PivotPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the four filter controls and a Run query action", () => {
    renderPanel();
    expect(screen.getByLabelText(/risk class/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^bucket$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sensitivity type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^book$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run query/i })).toBeEnabled();
  });

  it("renders the RedisQueryEngine EnterpriseCallout banner", () => {
    renderPanel();
    const callout = screen.getByTestId("enterprise-callout");
    expect(callout).toHaveAttribute("data-signal", "RedisQueryEngine");
  });

  it("offers Delta, Vega and Curvature in the sensitivity_type dropdown", () => {
    renderPanel();
    const select = screen.getByLabelText(/sensitivity type/i) as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.value);
    expect(opts).toEqual(expect.arrayContaining(["", "Delta", "Vega", "Curvature"]));
  });

  it("populates bucket dropdown options from the currently-selected risk_class", () => {
    renderPanel();
    const rc = screen.getByLabelText(/risk class/i) as HTMLSelectElement;
    const bucket = screen.getByLabelText(/^bucket$/i) as HTMLSelectElement;
    fireEvent.change(rc, { target: { value: "GIRR" } });
    const girrBuckets = Array.from(bucket.options).map((o) => o.value);
    expect(girrBuckets).toEqual(expect.arrayContaining(["USD-IRS", "EUR-IRS"]));
    fireEvent.change(rc, { target: { value: "Equity" } });
    const equityBuckets = Array.from(bucket.options).map((o) => o.value);
    expect(equityBuckets).toEqual(expect.arrayContaining(["B1", "B11"]));
    expect(equityBuckets).not.toContain("USD-IRS");
  });

  it("clicking Run query issues GET /pivot with the encoded filter params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => pivotResponse(),
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText(/risk class/i), { target: { value: "GIRR" } });
    fireEvent.change(screen.getByLabelText(/^bucket$/i), { target: { value: "USD-IRS" } });
    fireEvent.change(screen.getByLabelText(/sensitivity type/i), { target: { value: "Delta" } });
    fireEvent.change(screen.getByLabelText(/^book$/i), { target: { value: "RATES-LDN" } });
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/\/pivot\?/);
    expect(url).toContain("risk_class=GIRR");
    expect(url).toContain("bucket=USD-IRS");
    expect(url).toContain("sensitivity_type=Delta");
    expect(url).toContain("book=RATES-LDN");
    expect(url).toContain("limit=100");
    expect(url).toContain("offset=0");
  });

  it("omits empty filter params from the request URL", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ total: 0, rows: [] }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toMatch(/risk_class=(?:&|$)/);
    expect(url).not.toMatch(/bucket=(?:&|$)/);
    expect(url).not.toMatch(/book=(?:&|$)/);
  });

  it("renders successful results in a sortable table", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => pivotResponse() });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const table = await screen.findByRole("table", { name: /pivot results/i });
    const rows = within(table).getAllByRole("row");
    // header + 2 data rows
    expect(rows.length).toBe(3);
    expect(within(table).getByText(/sens:\{GIRR:USD-IRS\}:01HXAA/)).toBeInTheDocument();
    expect(within(table).getByText(/sens:\{GIRR:USD-IRS\}:01HXBB/)).toBeInTheDocument();
  });

  it("shows total / shown counts in the results summary", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ total: 250 }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await waitFor(() =>
      expect(screen.getByTestId("results-summary")).toHaveTextContent(/2.*of.*250/i)
    );
  });

  it("renders the empty-result state when total=0", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ total: 0, rows: [] }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await screen.findByText(/no sensitivities match these filters/i);
    expect(screen.queryByRole("table", { name: /pivot results/i })).toBeNull();
  });

  it("renders an error state when the fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const err = await screen.findByRole("alert");
    expect(err).toHaveTextContent(/network down|failed to load/i);
  });

  it("renders an error state when the api returns non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const err = await screen.findByRole("alert");
    expect(err).toHaveTextContent(/500|failed/i);
  });

  it("disables Run query while a request is in flight (loading state)", async () => {
    let resolve: (v: any) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderPanel();
    const btn = screen.getByRole("button", { name: /run query/i });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    resolve({ ok: true, json: async () => pivotResponse() });
    await waitFor(() => expect(btn).toBeEnabled());
  });

  it("updates the latency histogram with client-observed and server-reported ms per run", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ ms: 11.1 }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const hist = await screen.findByTestId("latency-histogram");
    // server ms is reported, client ms is measured (non-zero)
    expect(hist).toHaveTextContent(/11\.1\s*ms/);
    expect(within(hist).getByText(/server p50/i)).toBeInTheDocument();
    expect(within(hist).getByText(/server p95/i)).toBeInTheDocument();
    expect(within(hist).getByText(/server p99/i)).toBeInTheDocument();
    expect(within(hist).getByText(/client p50/i)).toBeInTheDocument();
  });

  it("pagination Next button advances offset by limit and re-fetches", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ total: 250 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ total: 250 }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await screen.findByRole("table", { name: /pivot results/i });
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const url = String(fetchMock.mock.calls[1]![0]);
    expect(url).toContain("offset=100");
    expect(url).toContain("limit=100");
  });

  it("pagination Previous is disabled on the first page and enabled after Next", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ total: 250 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ total: 250 }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await screen.findByRole("table", { name: /pivot results/i });
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /previous/i })).toBeEnabled());
  });

  it("Run 100x button fires 100 sequential pivots and populates the histogram", async () => {
    // Stub every call with a small randomised latency so percentiles are non-zero.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => pivotResponse({ ms: 5 + Math.random() * 20 }),
    }));
    renderPanel();
    const burst = screen.getByRole("button", { name: /run 100x/i });
    fireEvent.click(burst);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(100), { timeout: 5000 });
    // burst button is re-enabled once the run completes
    await waitFor(() => expect(burst).toBeEnabled());
  });

  it("Run 100x shows a progressbar that advances and disappears on completion", async () => {
    // Wave 5.21d — burst progress feedback. A small per-call delay keeps the
    // 100-iteration loop wider than waitFor's polling window so intermediate
    // aria-valuenow snapshots are observable.
    fetchMock.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ ok: true, json: async () => pivotResponse({ ms: 5 }) }), 1),
        ),
    );
    renderPanel();
    const burstBtn = screen.getByRole("button", { name: /run 100x/i });
    fireEvent.click(burstBtn);
    const bar = await screen.findByRole("progressbar", { name: /burst progress/i });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // both action buttons stay disabled while the burst is running
    expect(burstBtn).toBeDisabled();
    expect(screen.getByRole("button", { name: /running…/i })).toBeDisabled();
    // aria-valuenow advances as iterations complete; numeric label tracks it
    await waitFor(() => {
      const v = Number(bar.getAttribute("aria-valuenow"));
      expect(v).toBeGreaterThan(0);
      const progress = screen.getByTestId("pivot-burst-progress");
      expect(within(progress).getByText(new RegExp(`Running ${v} \\/ 100…`))).toBeInTheDocument();
    });
    // bar disappears once the burst completes
    await waitFor(
      () => expect(screen.queryByRole("progressbar", { name: /burst progress/i })).toBeNull(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(burstBtn).toBeEnabled());
  });

  it("Run 100x burst stops and hides the progressbar when an iteration returns HTTP 500", async () => {
    // Wave 5.21d — mid-burst failure: iterations 1 and 2 succeed, iteration 3
    // returns 500. The burst halts, the bar disappears, and the existing error
    // banner takes over.
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ ms: 5 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ ms: 5 }) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run 100x/i }));
    const err = await screen.findByRole("alert");
    expect(err).toHaveTextContent(/500|failed/i);
    await waitFor(() =>
      expect(screen.queryByRole("progressbar", { name: /burst progress/i })).toBeNull(),
    );
    // Loop halted on the failing iteration — no further pivot requests fire.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Both buttons are re-enabled so the user can retry.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run 100x/i })).toBeEnabled(),
    );
  });

  it("renders a <100ms 'sub-100ms' callout on the first successful run when server ms < 100", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => pivotResponse({ ms: 7.5 }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const callout = await screen.findByTestId("sub-100ms-callout");
    expect(callout).toHaveTextContent(/sub.?100/i);
    expect(callout).toHaveTextContent(/7\.5\s*ms/);
  });
});

