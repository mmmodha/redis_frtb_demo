// Wave 5.47d — per-class targets table in the SyntheticGeneratorCard. Covers:
//   - the table renders one row per selected class with a number input
//   - "Even split" populates equal counts based on Rows
//   - submit sends the populated class_split in the request body

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
  const terminal = { run_id: "01HXSPLIT", done: true, rows_queued: 150, ms: 90, cancelled: false };
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

describe("<IngestPanel /> — per-class targets (Wave 5.47d)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders one input per selected class in the Per-class targets table", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const splitGroup = within(card).getByTestId("generator-class-split");
    // All three default classes show up as inputs labeled by class name.
    for (const c of ["GIRR", "Equity", "FX"]) {
      const input = within(splitGroup).getByLabelText(c) as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.type).toBe("number");
      expect(input.value).toBe("");
    }
  });

  it("'Even split' populates the table with equal counts that sum to Rows", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const splitGroup = within(card).getByTestId("generator-class-split");
    fireEvent.click(within(splitGroup).getByTestId("generator-even-split-btn"));
    // Default rows=200, 3 classes ⇒ 67 + 66 + 67 = 200 (remainder lands on first).
    const girr = within(splitGroup).getByLabelText("GIRR") as HTMLInputElement;
    const equity = within(splitGroup).getByLabelText("Equity") as HTMLInputElement;
    const fx = within(splitGroup).getByLabelText("FX") as HTMLInputElement;
    const total = Number(girr.value) + Number(equity.value) + Number(fx.value);
    expect(total).toBe(200);
    // First class absorbs the remainder so the floor split is even otherwise.
    expect(Number(equity.value)).toBe(66);
    expect(Number(fx.value)).toBe(66);
    expect(Number(girr.value)).toBe(68);
  });

  it("submit sends the populated class_split in the request body (and omits `rows`)", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const splitGroup = within(card).getByTestId("generator-class-split");
    fireEvent.change(within(splitGroup).getByLabelText("GIRR"), { target: { value: "100" } });
    fireEvent.change(within(splitGroup).getByLabelText("FX"), { target: { value: "50" } });
    // Equity stays blank ⇒ excluded from class_split.
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const posted = fetchMock.mock.calls.find(
      (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    )!;
    const body = JSON.parse((posted[1] as RequestInit).body as string);
    expect(body.class_split).toEqual({ GIRR: 100, FX: 50 });
    expect(body).not.toHaveProperty("rows");
  });
});
