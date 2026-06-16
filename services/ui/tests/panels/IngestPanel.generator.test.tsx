// Wave 5.17b — synthetic generator form in IngestPanel.
//
// Covers the new "Synthetic generator" PanelCard: default values, body shape
// on submit, client-side validation, and post-success status surfacing.

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

function keysResponse(dbsize: number, sample: string[] = []) {
  return { prefix: "sens:", dbsize, sample, sample_size: sample.length, ms: 1 };
}
function memoryResponse(used_memory: number) {
  return { used_memory, used_memory_human: `${used_memory}B`, ms: 1 };
}

// Wave 5.20c — build a fake SSE ReadableStream body from a list of frames.
// Each frame is JSON-encoded and wrapped as `data: {...}\n\n`. The mock fetch
// returns a Response-like object whose `body.getReader()` yields the encoded
// bytes — matching what the streaming client does in lib/ingest.ts.
function sseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
}

function baselineFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  terminal: Record<string, unknown> = { run_id: "01HXTEST", done: true, rows_queued: 200, ms: 145, cancelled: false },
  progress: Record<string, unknown>[] = [],
) {
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET")
      return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
    if (url.endsWith("/generator/start/stream") && method === "POST")
      return { ok: true, body: sseBody([...progress, terminal]) };
    if (/\/generator\/cancel\//.test(url) && method === "POST")
      return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({}) };
  });
}

function generatorCard() {
  return screen.getAllByTestId("panel-card").find((el) => el.getAttribute("data-title") === "Synthetic generator")!;
}

// Wave 5.52 — most legacy controls live under the "Show advanced…" disclosure.
function openAdvanced(card: HTMLElement) {
  fireEvent.click(within(card).getByTestId("generator-advanced-toggle"));
}

describe("<IngestPanel /> — synthetic generator card (Wave 5.17b / 5.52)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders simple-mode defaults (200 rows + 34/33/33 mix) and advanced legacy fields after opening Advanced", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    expect(within(card).getByRole("heading", { name: /synthetic generator/i })).toBeInTheDocument();

    // Wave 5.52 — simple-mode: Total rows + Class mix percent inputs.
    const totalRows = within(card).getByLabelText(/^total rows$/i) as HTMLInputElement;
    expect(totalRows.value).toBe("200");
    expect((within(card).getByLabelText("GIRR") as HTMLInputElement).value).toBe("34");
    expect((within(card).getByLabelText("Equity") as HTMLInputElement).value).toBe("33");
    expect((within(card).getByLabelText("FX") as HTMLInputElement).value).toBe("33");

    // Opening Advanced reveals the legacy controls pre-populated with derived values.
    openAdvanced(card);
    for (const c of ["GIRR", "Equity", "FX"]) {
      const cb = within(card).getByRole("checkbox", { name: c }) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    }
    expect((within(card).getByRole("checkbox", { name: "Delta" }) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByRole("checkbox", { name: "Vega" }) as HTMLInputElement).checked).toBe(true);
    // Wave 6.10 — Curvature is checked by default in advanced mode.
    expect((within(card).getByRole("checkbox", { name: "Curvature" }) as HTMLInputElement).checked).toBe(true);

    expect((within(card).getByTestId("generator-preset") as HTMLSelectElement).value).toBe("custom");
    expect((within(card).getByLabelText(/trade pool size/i) as HTMLInputElement).value).toBe("50");
    expect((within(card).getByLabelText(/risk factor pool size/i) as HTMLInputElement).value).toBe("8");
    expect(within(card).getByTestId("generator-generate-btn")).toBeInTheDocument();
  });

  it("submitting in simple mode POSTs the auto-derived body shape (Wave 5.52)", async () => {
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
    const posted = fetchMock.mock.calls.find(
      (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    )!;
    const body = JSON.parse((posted[1] as RequestInit).body as string);
    expect(body.class_split).toEqual({ GIRR: 68, Equity: 66, FX: 66 });
    expect(body.sensitivity_types).toEqual(["Delta", "Vega", "Curvature"]);
    expect(body.trade_pool_size).toBe(50);
    expect(body.factor_pool_size).toBe(8);
    expect(body.stop_when).toEqual({ rows: 200, memory_pct: 75, elapsed_seconds: 600 });
    expect(typeof body.seed).toBe("number");
    // Simple-mode never sends `rows` (class_split fully determines the count).
    expect(body).not.toHaveProperty("rows");
  });

  it("advanced submit blocks and shows a role=alert when no risk class is checked", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    openAdvanced(card);
    for (const c of ["GIRR", "Equity", "FX"]) {
      fireEvent.click(within(card).getByRole("checkbox", { name: c }));
    }
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toMatch(/risk class/i);
    const posted = fetchMock.mock.calls.find(
      (c) => /\/generator\/start(\/stream)?$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("shows 'Done — N rows queued in Xms · run_id …' status line after a successful stream", async () => {
    baselineFetch(
      fetchMock,
      { run_id: "01HXABCDEF", done: true, rows_queued: 200, ms: 145, cancelled: false },
    );
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    const status = await within(card).findByTestId("generator-status");
    expect(status.textContent).toMatch(/done\s*\u2014\s*200\s+rows\s+queued\s+in\s+145ms/i);
    expect(status.textContent).toMatch(/run_id/i);
    expect(within(status).getByText("01HXABCDEF")).toBeInTheDocument();
  });

  it("renders the live progress bar while streaming and reaches 100% on the terminal frame", async () => {
    baselineFetch(
      fetchMock,
      { run_id: "01HXSTREAM", done: true, rows_queued: 500, ms: 320, cancelled: false },
      [
        { run_id: "01HXSTREAM", rows_done: 100, rows_total: 500, elapsed_ms: 80, rows_per_sec: 1250 },
        { run_id: "01HXSTREAM", rows_done: 300, rows_total: 500, elapsed_ms: 200, rows_per_sec: 1500 },
      ],
    );
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    const status = await within(card).findByTestId("generator-status");
    expect(status.textContent).toMatch(/done\s*\u2014\s*500\s+rows\s+queued\s+in\s+320ms/i);
  });

  it("clicking Cancel during a run POSTs /generator/cancel/{run_id} and shows the cancelled summary", async () => {
    // Hand-built fetch: pause the stream after the first progress frame so the
    // Cancel button is visible long enough for the test to click it; the
    // terminal frame is emitted only after cancellation lands.
    let releaseTerminal: (() => void) | null = null;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const enc = new TextEncoder();
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(0) };
      if (url.endsWith("/generator/start/stream") && method === "POST") {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ run_id: "01HXCANCEL", rows_done: 50, rows_total: 1000, elapsed_ms: 40, rows_per_sec: 1250 })}\n\n`));
            await terminalGate;
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ run_id: "01HXCANCEL", done: true, rows_queued: 60, ms: 120, cancelled: true })}\n\n`));
            controller.close();
          },
        });
        return { ok: true, body };
      }
      if (/\/generator\/cancel\/01HXCANCEL$/.test(url) && method === "POST") {
        releaseTerminal?.();
        return { ok: true, json: async () => ({ ok: true, cancelled: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    const cancelBtn = await within(card).findByTestId("generator-cancel-btn");
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/cancel\/01HXCANCEL$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    const status = await within(card).findByTestId("generator-status");
    expect(status.textContent).toMatch(/cancelled\s*\u2014\s*60\s+rows\s+queued\s+in\s+120ms/i);
  });
});
