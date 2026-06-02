// Wave 5.49 — Realistic profile (preset) dropdown in the SyntheticGeneratorCard.
//
// Covers:
//   - default preset is "small" and the dropdown renders the named tiers
//   - switching to "single-desk" submits trade_pool_size=2000 / factor_pool_size=32
//   - switching to "custom" reveals the raw trade/factor inputs (preserves
//     the last preset's values so power users can tweak from a known tier)
//   - selecting any non-custom preset removes the raw inputs from the DOM

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
  const terminal = { run_id: "01HXPRESET", done: true, rows_queued: 200, ms: 90, cancelled: false };
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

function postedBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const posted = fetchMock.mock.calls.find(
    (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
  )!;
  return JSON.parse((posted[1] as RequestInit).body as string);
}

describe("<IngestPanel /> — Realistic profile presets (Wave 5.49)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the preset dropdown with 'Small desk' selected by default and the four named tiers + Custom", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const select = within(card).getByTestId("generator-preset") as HTMLSelectElement;
    expect(select.value).toBe("small");
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["small", "single-desk", "trading-book", "full-bank", "custom"]);
    expect(select.options[0]!.text).toMatch(/Small desk/);
  });

  it("non-custom presets hide the raw trade_pool / factor_pool inputs", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    expect(within(card).queryByLabelText(/trade pool size/i)).toBeNull();
    expect(within(card).queryByLabelText(/risk factor pool size/i)).toBeNull();
  });

  it("switching to 'Single desk realistic' submits trade_pool_size=2000 and factor_pool_size=32", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.change(within(card).getByTestId("generator-preset"), { target: { value: "single-desk" } });
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const body = postedBody(fetchMock);
    expect(body.trade_pool_size).toBe(2000);
    expect(body.factor_pool_size).toBe(32);
  });

  it("switching to 'Custom…' reveals the raw trade/factor inputs pre-populated with the last preset's values", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    // Bump to trading-book so the carried-over numbers are obviously preset-derived.
    fireEvent.change(within(card).getByTestId("generator-preset"), { target: { value: "trading-book" } });
    fireEvent.change(within(card).getByTestId("generator-preset"), { target: { value: "custom" } });
    const trade = within(card).getByLabelText(/trade pool size/i) as HTMLInputElement;
    const factor = within(card).getByLabelText(/risk factor pool size/i) as HTMLInputElement;
    expect(trade.value).toBe("20000");
    expect(factor.value).toBe("64");
  });
});
