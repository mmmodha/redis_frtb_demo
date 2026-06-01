// Wave 5.17b — synthetic generator form in IngestPanel.
//
// Covers the new "Synthetic generator" PanelCard: default values, body shape
// on submit, client-side validation, and post-success status surfacing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2>{actions}</header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: any) => (
    <aside data-signal={signal}>{children}</aside>
  ),
}));
vi.mock("../../src/components/MetricTile", () => ({
  MetricTile: ({ label, value }: any) => (<div data-label={label}>{value}</div>),
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

function baselineFetch(fetchMock: ReturnType<typeof vi.fn>, generatorBody: unknown = { ok: true, rows_queued: 200, ms: 145, run_id: "01HXTEST" }) {
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET")
      return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
    if (url.endsWith("/generator/start") && method === "POST")
      return { ok: true, json: async () => generatorBody };
    return { ok: true, json: async () => ({}) };
  });
}

function generatorCard() {
  return screen.getAllByTestId("panel-card").find((el) => el.getAttribute("data-title") === "Synthetic generator")!;
}

describe("<IngestPanel /> — synthetic generator card (Wave 5.17b)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the form with correct defaults: rows=200, all classes checked, Delta+Vega checked, seed=0, trade pool empty (auto), factor pool=16", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    expect(within(card).getByRole("heading", { name: /synthetic generator/i })).toBeInTheDocument();

    const rows = within(card).getByLabelText(/^rows$/i) as HTMLInputElement;
    expect(rows.value).toBe("200");

    for (const c of ["GIRR", "Equity", "FX"]) {
      const cb = within(card).getByRole("checkbox", { name: c }) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    }
    expect((within(card).getByRole("checkbox", { name: "Delta" }) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByRole("checkbox", { name: "Vega" }) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByRole("checkbox", { name: "Curvature" }) as HTMLInputElement).checked).toBe(false);

    expect((within(card).getByLabelText(/^seed$/i) as HTMLInputElement).value).toBe("0");
    expect((within(card).getByLabelText(/trade pool size/i) as HTMLInputElement).value).toBe("");
    expect((within(card).getByLabelText(/risk factor pool size/i) as HTMLInputElement).value).toBe("16");
    expect(within(card).getByRole("button", { name: /^generate$/i })).toBeInTheDocument();
  });

  it("submitting with defaults POSTs the correct body shape to /generator/start (auto trade pool ⇒ key omitted)", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const posted = fetchMock.mock.calls.find(
      (c) => /\/generator\/start$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    )!;
    const body = JSON.parse((posted[1] as RequestInit).body as string);
    expect(body).toEqual({
      rows: 200,
      classes: ["GIRR", "Equity", "FX"],
      sensitivity_types: ["Delta", "Vega"],
      seed: 0,
      factor_pool_size: 16,
    });
    expect(body).not.toHaveProperty("trade_pool_size");
  });

  it("blocks submit and shows a role=alert when no risk class is checked", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    for (const c of ["GIRR", "Equity", "FX"]) {
      fireEvent.click(within(card).getByRole("checkbox", { name: c }));
    }
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toMatch(/risk class/i);
    const posted = fetchMock.mock.calls.find(
      (c) => /\/generator\/start$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("shows 'Generated N rows in Xms · run_id …' status line after a successful submit", async () => {
    baselineFetch(fetchMock, { ok: true, rows_queued: 200, ms: 145, run_id: "01HXABCDEF" });
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    const status = await within(card).findByTestId("generator-status");
    expect(status.textContent).toMatch(/generated\s+200\s+rows\s+in\s+145ms/i);
    expect(status.textContent).toMatch(/run_id/i);
    expect(within(status).getByText("01HXABCDEF")).toBeInTheDocument();
  });
});
