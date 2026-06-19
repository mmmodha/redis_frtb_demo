import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { JsonExplorerPanel } from "../../src/panels/JsonExplorerPanel";
import { installFetchIntercept, installFetchRouter } from "../helpers/fetch-mock";

vi.mock("../../src/components/PanelCard", () => ({
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

function renderPanel() {
  return render(
    <MemoryRouter>
      <JsonExplorerPanel />
    </MemoryRouter>,
  );
}

function explorerResponse() {
  return {
    total: 3,
    limit: 25,
    offset: 0,
    ms: 5,
    rows: [
      {
        key: "sens:{GIRR:USD-IRS}:01HXAA",
        doc: {
          risk_class: "GIRR",
          bucket: "USD-IRS",
          sensitivity_type: "Delta",
          book: "RATES-LDN",
          trade_id: "T-1",
          risk_value: [0.1, 0.2, 0.3],
        },
      },
      {
        key: "sens:{GIRR:USD-IRS}:01HXBB",
        doc: {
          risk_class: "GIRR",
          bucket: "USD-IRS",
          sensitivity_type: "Delta",
          book: "RATES-LDN",
          trade_id: "T-2",
        },
      },
      {
        key: "sens:{GIRR:EUR-IRS}:01HXCC",
        doc: {
          risk_class: "GIRR",
          bucket: "EUR-IRS",
          sensitivity_type: "Vega",
          book: "RATES-FRA",
          trade_id: "T-3",
        },
      },
    ],
  };
}

describe("JsonExplorerPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Wave 5.56 — intercept /facets + /suggest so the test's once-queue
    // sees only /pivot.
    fetchMock = installFetchIntercept();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders all filter controls including trade_id and page size", () => {
    renderPanel();
    expect(screen.getByLabelText(/risk class/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^bucket$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sensitivity type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^book$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/trade id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/page size/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run query/i })).toBeEnabled();
  });

  it("populates bucket dropdown from selected risk class", () => {
    renderPanel();
    const rc = screen.getByLabelText(/risk class/i) as HTMLSelectElement;
    const bucket = screen.getByLabelText(/^bucket$/i) as HTMLSelectElement;
    fireEvent.change(rc, { target: { value: "GIRR" } });
    const opts = Array.from(bucket.options).map((o) => o.value);
    expect(opts).toEqual(expect.arrayContaining(["USD-IRS", "EUR-IRS"]));
  });

  it("submitting filters calls /pivot with the matching query string", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => explorerResponse() });
    renderPanel();
    fireEvent.change(screen.getByLabelText(/risk class/i), { target: { value: "GIRR" } });
    fireEvent.change(screen.getByLabelText(/^bucket$/i), { target: { value: "USD-IRS" } });
    fireEvent.change(screen.getByLabelText(/sensitivity type/i), { target: { value: "Delta" } });
    fireEvent.change(screen.getByLabelText(/^book$/i), { target: { value: "RATES-LDN" } });
    fireEvent.change(screen.getByLabelText(/trade id/i), { target: { value: "T-1" } });
    fireEvent.change(screen.getByLabelText(/page size/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/\/pivot\?/);
    expect(url).toContain("risk_class=GIRR");
    expect(url).toContain("bucket=USD-IRS");
    expect(url).toContain("sensitivity_type=Delta");
    expect(url).toContain("book=RATES-LDN");
    expect(url).toContain("trade_id=T-1");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=0");
  });

  it("renders returned rows in the results table", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => explorerResponse() });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const table = await screen.findByRole("table", { name: /explorer results/i });
    const rows = within(table).getAllByTestId("explorer-row");
    expect(rows.length).toBe(3);
  });

  it("expanding a row reveals the full JSON document and collapses back", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => explorerResponse() });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await screen.findByRole("table", { name: /explorer results/i });
    expect(screen.queryByTestId("explorer-doc")).toBeNull();
    const expand = screen.getByRole("button", { name: /expand sens:\{GIRR:USD-IRS\}:01HXAA/i });
    fireEvent.click(expand);
    const doc = await screen.findByTestId("explorer-doc");
    expect(doc).toHaveTextContent(/"risk_value"/);
    expect(doc).toHaveTextContent(/"trade_id":\s*"T-1"/);
    fireEvent.click(screen.getByRole("button", { name: /collapse sens:\{GIRR:USD-IRS\}:01HXAA/i }));
    await waitFor(() => expect(screen.queryByTestId("explorer-doc")).toBeNull());
  });

  it("key-contains filter narrows rendered rows client-side without re-fetching", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => explorerResponse() });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const table = await screen.findByRole("table", { name: /explorer results/i });
    expect(within(table).getAllByTestId("explorer-row").length).toBe(3);
    fireEvent.change(screen.getByLabelText(/key contains/i), { target: { value: "EUR-IRS" } });
    await waitFor(() =>
      expect(within(table).getAllByTestId("explorer-row").length).toBe(1),
    );
    expect(within(table).getByText(/sens:\{GIRR:EUR-IRS\}:01HXCC/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders the empty-result state when total=0", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total: 0, limit: 25, offset: 0, ms: 2, rows: [] }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await screen.findByText(/no documents match these filters/i);
    expect(screen.queryByRole("table", { name: /explorer results/i })).toBeNull();
  });

  it("renders an error state when the fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const err = await screen.findByRole("alert");
    expect(err).toHaveTextContent(/network down|failed/i);
  });

  it("Wave 5.56 — risk_class / bucket / sensitivity_type dropdowns reflect facet hits", async () => {
    installFetchRouter({
      facets: {
        ok: true, status: 200, json: async () => ({
          ok: true, ms: 2, target_label: "primary", total_rows: 9,
          risk_class: { GIRR: 6, FX: 3 },
          sensitivity_type: { Delta: 7, Curvature: 2 },
          bucket_by_risk_class: { GIRR: { "EUR-IRS": 6 }, FX: { EURUSD: 3 } },
        }),
      },
    });
    renderPanel();
    const rc = await screen.findByLabelText(/risk class/i) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(rc.options).map((o) => o.value)).toEqual(["", "GIRR", "FX"]);
    });
    expect(Array.from(rc.options).map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["GIRR", "FX"]),
    );
    const sens = screen.getByLabelText(/sensitivity type/i) as HTMLSelectElement;
    const sensValues = Array.from(sens.options).map((o) => o.value);
    expect(sensValues).toEqual(["", "Delta", "Curvature"]);
    expect(sensValues).not.toContain("Vega");
    fireEvent.change(rc, { target: { value: "GIRR" } });
    const bucket = screen.getByLabelText(/^bucket$/i) as HTMLSelectElement;
    expect(Array.from(bucket.options).map((o) => o.value)).toEqual(["", "EUR-IRS"]);
  });

  it("renders the empty-target amber banner for 412 responses", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 412,
      json: async () => ({ target_label: "primary", bootstrap_phase: "indexing" }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const banner = await screen.findByTestId("empty-target-banner");
    expect(banner).toHaveAttribute("data-kind", "bootstrap");
    expect(banner).toHaveTextContent(/primary/);
  });
});
