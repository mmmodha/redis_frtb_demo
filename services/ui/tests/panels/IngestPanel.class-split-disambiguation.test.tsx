// Wave 5.50 — per-class row targets / Rows field disambiguation. Covers:
//   - Sum line under the per-class targets table (inactive vs active text)
//   - Rows input is disabled while class_split is active and re-enabled when
//     all per-class inputs are cleared
//   - Submit body parity: class_split active ⇒ no `rows`; empty ⇒ `rows`
//     present and `class_split` omitted (today's behaviour preserved)

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
      <GeneratorRunProvider>
        <IngestPanel />
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
}

function keysResponse(dbsize: number) {
  return { prefix: "sens:", dbsize, sample: [], sample_size: 0, ms: 1 };
}
function memoryResponse(used_memory: number) {
  return { used_memory, used_memory_human: `${used_memory}B`, ms: 1 };
}

function sseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
}

function baselineFetch(fetchMock: ReturnType<typeof vi.fn>) {
  const terminal = { run_id: "01HXDISAMB", done: true, rows_queued: 150, ms: 90, cancelled: false };
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET")
      return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
    if (url.endsWith("/generator/start/stream") && method === "POST")
      return { ok: true, body: sseBody([terminal]) };
    if (/\/generator\/cancel\//.test(url) && method === "POST")
      return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({}) };
  });
}

function generatorCard() {
  return screen.getAllByTestId("panel-card").find((el) => el.getAttribute("data-title") === "Synthetic generator")!;
}

function postedGeneratorBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const posted = fetchMock.mock.calls.find(
    (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
  )!;
  return JSON.parse((posted[1] as RequestInit).body as string);
}

describe("<IngestPanel /> — per-class row targets disambiguation (Wave 5.50)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("empty class_split ⇒ Rows is enabled and sum line surfaces the round-robin fallback text", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const rowsInput = within(card).getByLabelText(/^rows$/i) as HTMLInputElement;
    expect(rowsInput.disabled).toBe(false);
    const sumLine = within(card).getByTestId("class-split-sum");
    expect(sumLine.textContent).toBe("Sum: 0 rows (using Rows + round-robin)");
  });

  it("typing a positive value into a per-class input disables Rows and updates the sum line", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const splitGroup = within(card).getByTestId("generator-class-split");
    fireEvent.change(within(splitGroup).getByLabelText("GIRR"), { target: { value: "100" } });
    const rowsInput = within(card).getByLabelText(/^rows$/i) as HTMLInputElement;
    expect(rowsInput.disabled).toBe(true);
    expect(within(card).getByTestId("class-split-sum").textContent).toBe("Sum: 100 rows");
    // The hint next to Rows surfaces the same live sum.
    expect(within(card).getByTestId("gen-rows-hint").textContent).toMatch(/sum = 100/);
  });

  it("sum line updates live as additional per-class inputs change", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const splitGroup = within(card).getByTestId("generator-class-split");
    fireEvent.change(within(splitGroup).getByLabelText("GIRR"), { target: { value: "100" } });
    expect(within(card).getByTestId("class-split-sum").textContent).toBe("Sum: 100 rows");
    fireEvent.change(within(splitGroup).getByLabelText("Equity"), { target: { value: "50" } });
    expect(within(card).getByTestId("class-split-sum").textContent).toBe("Sum: 150 rows");
    fireEvent.change(within(splitGroup).getByLabelText("FX"), { target: { value: "25" } });
    expect(within(card).getByTestId("class-split-sum").textContent).toBe("Sum: 175 rows");
  });

  it("clearing all per-class inputs re-enables Rows and reverts the sum line", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const splitGroup = within(card).getByTestId("generator-class-split");
    fireEvent.change(within(splitGroup).getByLabelText("GIRR"), { target: { value: "100" } });
    expect((within(card).getByLabelText(/^rows$/i) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(splitGroup).getByLabelText("GIRR"), { target: { value: "" } });
    const rowsInput = within(card).getByLabelText(/^rows$/i) as HTMLInputElement;
    expect(rowsInput.disabled).toBe(false);
    expect(within(card).getByTestId("class-split-sum").textContent).toBe("Sum: 0 rows (using Rows + round-robin)");
    expect(within(card).queryByTestId("gen-rows-hint")).toBeNull();
  });

  it("submit body when class_split is active omits `rows` and includes the populated class_split", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const splitGroup = within(card).getByTestId("generator-class-split");
    fireEvent.change(within(splitGroup).getByLabelText("GIRR"), { target: { value: "100" } });
    fireEvent.change(within(splitGroup).getByLabelText("FX"), { target: { value: "50" } });
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const body = postedGeneratorBody(fetchMock);
    expect(body.class_split).toEqual({ GIRR: 100, FX: 50 });
    expect(body).not.toHaveProperty("rows");
  });

  it("submit body when class_split is empty includes `rows` and omits `class_split` (today's behaviour preserved)", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const body = postedGeneratorBody(fetchMock);
    expect(body.rows).toBe(200);
    expect(body).not.toHaveProperty("class_split");
  });
});
