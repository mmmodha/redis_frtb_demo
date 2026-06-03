// Wave 5.52 — synthetic generator UX overhaul. Covers the new simple-mode
// card (Total rows + Class mix + Generate + Reset to canonical + Last seed),
// the class-mix sum validation pill, quick-pick row buttons, and the
// "Show advanced…" disclosure with auto-derived pre-populated values.

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
  const terminal = { run_id: "01HXSIMPLE", done: true, rows_queued: 200, ms: 80, cancelled: false };
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
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

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const posted = fetchMock.mock.calls.find(
    (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
  )!;
  return JSON.parse((posted[1] as RequestInit).body as string);
}

describe("<IngestPanel /> — Wave 5.52 simple-mode generator", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders Total rows (200) and Class mix (60/30/10) as the only visible controls; advanced is collapsed", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    expect((within(card).getByLabelText(/^total rows$/i) as HTMLInputElement).value).toBe("200");
    expect((within(card).getByLabelText("GIRR") as HTMLInputElement).value).toBe("60");
    expect((within(card).getByLabelText("Equity") as HTMLInputElement).value).toBe("30");
    expect((within(card).getByLabelText("FX") as HTMLInputElement).value).toBe("10");
    // Advanced disclosure is collapsed (no preset dropdown visible).
    expect(within(card).queryByTestId("generator-preset")).toBeNull();
    expect(within(card).getByTestId("generator-advanced-toggle")).toHaveAttribute("aria-expanded", "false");
    // Last-seed pill hidden until a run is kicked off.
    expect(within(card).queryByTestId("generator-last-seed")).toBeNull();
  });

  it("quick-pick row buttons (200 · 2k · 20k · 200k · 2M) update the Total rows input", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const rows = within(card).getByLabelText(/^total rows$/i) as HTMLInputElement;
    fireEvent.click(within(card).getByTestId("generator-quick-pick-2k"));
    expect(rows.value).toBe("2000");
    fireEvent.click(within(card).getByTestId("generator-quick-pick-200k"));
    expect(rows.value).toBe("200000");
    fireEvent.click(within(card).getByTestId("generator-quick-pick-2M"));
    expect(rows.value).toBe("2000000");
  });

  it("submit auto-derives class_split, trade/factor pool, sens_types and stop_when from rows + mix", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const body = postedBody(fetchMock);
    expect(body.class_split).toEqual({ GIRR: 120, Equity: 60, FX: 20 });
    expect(body.sensitivity_types).toEqual(["Delta", "Vega"]);
    // rows=200 ⇒ max(50, min(10000, floor(200/20))) = 50
    expect(body.trade_pool_size).toBe(50);
    // rows=200 ⇒ max(8, min(256, floor(200/200))) = 8
    expect(body.factor_pool_size).toBe(8);
    expect(body.stop_when).toEqual({ rows: 200, memory_pct: 75, elapsed_seconds: 600 });
    expect(typeof body.seed).toBe("number");
    expect(body).not.toHaveProperty("rows");
  });

  it("class-mix sum != 100 disables Generate and shows the inline pill (currently N)", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.change(within(card).getByLabelText("FX"), { target: { value: "20" } });
    // Mix is now 60 + 30 + 20 = 110.
    const pill = within(card).getByTestId("generator-mix-pill");
    expect(pill.textContent).toMatch(/sum to 100/i);
    expect(pill.textContent).toMatch(/currently 110/);
    expect((within(card).getByTestId("generator-generate-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("auto-derived class_split omits classes set to 0% and the remainder lands on the last non-zero class", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    // Mix = 70/30/0 ⇒ Equity is last non-zero and absorbs any remainder.
    fireEvent.change(within(card).getByLabelText("GIRR"), { target: { value: "70" } });
    fireEvent.change(within(card).getByLabelText("Equity"), { target: { value: "30" } });
    fireEvent.change(within(card).getByLabelText("FX"), { target: { value: "0" } });
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const body = postedBody(fetchMock);
    expect(body.class_split).toEqual({ GIRR: 140, Equity: 60 });
    expect(body.class_split as Record<string, number>).not.toHaveProperty("FX");
  });

  it("Reset to canonical demo sets rows=200, GIRR=100% Equity=0% FX=0% and stages seed=0xCAFEBABE", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    // Move state somewhere non-canonical first so the reset is observable.
    fireEvent.click(within(card).getByTestId("generator-quick-pick-2k"));
    fireEvent.change(within(card).getByLabelText("GIRR"), { target: { value: "40" } });
    fireEvent.change(within(card).getByLabelText("Equity"), { target: { value: "40" } });
    fireEvent.change(within(card).getByLabelText("FX"), { target: { value: "20" } });

    fireEvent.click(within(card).getByTestId("generator-reset-canonical-btn"));
    expect((within(card).getByLabelText(/^total rows$/i) as HTMLInputElement).value).toBe("200");
    expect((within(card).getByLabelText("GIRR") as HTMLInputElement).value).toBe("100");
    expect((within(card).getByLabelText("Equity") as HTMLInputElement).value).toBe("0");
    expect((within(card).getByLabelText("FX") as HTMLInputElement).value).toBe("0");

    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const body = postedBody(fetchMock);
    expect(body.seed).toBe(0xCAFEBABE);
    expect(body.class_split).toEqual({ GIRR: 200 });
    expect(body.sensitivity_types).toEqual(["Delta", "Vega"]);
  });

  it("the Last seed pill appears after the first run and shows the formatted hex seed", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByTestId("generator-reset-canonical-btn"));
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    const pill = await within(card).findByTestId("generator-last-seed");
    expect(pill.textContent).toMatch(/0xCAFEBABE/i);
    const copyBtn = within(card).getByTestId("generator-last-seed-copy");
    expect(copyBtn.textContent).toMatch(/0xCAFEBABE/i);
  });

  it("opening Advanced pre-populates legacy fields with the simple-mode auto-derived values (non-destructive reveal)", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    // Bump to 20k rows so the derived pools are obviously different from the default 50/8.
    fireEvent.click(within(card).getByTestId("generator-quick-pick-20k"));
    fireEvent.click(within(card).getByTestId("generator-advanced-toggle"));

    // Trade pool 20000/20 = 1000 (clamped within [50, 10000]).
    expect((within(card).getByLabelText(/trade pool size/i) as HTMLInputElement).value).toBe("1000");
    // Factor pool 20000/200 = 100 (clamped within [8, 256]).
    expect((within(card).getByLabelText(/risk factor pool size/i) as HTMLInputElement).value).toBe("100");
    // Per-class split mirrors the 60/30/10 mix for 20000 rows.
    const splitGroup = within(card).getByTestId("generator-class-split");
    expect((within(splitGroup).getByLabelText("GIRR") as HTMLInputElement).value).toBe("12000");
    expect((within(splitGroup).getByLabelText("Equity") as HTMLInputElement).value).toBe("6000");
    expect((within(splitGroup).getByLabelText("FX") as HTMLInputElement).value).toBe("2000");
    // Stop conditions: rows=20000, memory_pct=75, elapsed=600.
    const stop = within(card).getByTestId("generator-stop-when");
    expect((within(stop).getByLabelText(/Stop after rows/i) as HTMLInputElement).value).toBe("20000");
    expect((within(stop).getByLabelText(/Stop at memory %/i) as HTMLInputElement).value).toBe("75");
    expect((within(stop).getByLabelText(/Stop after seconds/i) as HTMLInputElement).value).toBe("600");
    // Delta + Vega checked, Curvature unchecked.
    expect((within(card).getByRole("checkbox", { name: "Delta" }) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByRole("checkbox", { name: "Vega" }) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByRole("checkbox", { name: "Curvature" }) as HTMLInputElement).checked).toBe(false);
  });

  it("rows quick-pick clears any staged canonical seed (next Generate draws a fresh seed)", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByTestId("generator-reset-canonical-btn"));
    fireEvent.click(within(card).getByTestId("generator-quick-pick-2k"));
    // After moving rows, canonical seed is no longer staged.
    // Mix is still 100/0/0 from reset; Generate is allowed since sum=100.
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const body = postedBody(fetchMock);
    expect(body.seed).not.toBe(0xCAFEBABE);
    expect(typeof body.seed).toBe("number");
  });
});
