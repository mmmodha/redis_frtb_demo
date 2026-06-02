// Wave 5.47c — optional Stop conditions in the SyntheticGeneratorCard.
// Covers:
//   - the Stop conditions fieldset renders inside advanced options
//   - submitting with memory_pct=70 sends stop_when:{memory_pct:70}
//   - leaving all fields blank omits stop_when from the body
//   - terminal frame with stop_reason="elapsed" surfaces in the status pill

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

function baselineFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  terminal: Record<string, unknown> = { run_id: "01HXSTOP", done: true, rows_queued: 200, ms: 90, cancelled: false },
) {
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

describe("<IngestPanel /> — Stop conditions (Wave 5.47c)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the Stop conditions fieldset with three blank inputs", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const group = within(card).getByTestId("generator-stop-when");
    const rowsInput = within(group).getByLabelText(/Stop after rows/i) as HTMLInputElement;
    const memInput = within(group).getByLabelText(/Stop at memory %/i) as HTMLInputElement;
    const elapsedInput = within(group).getByLabelText(/Stop after seconds/i) as HTMLInputElement;
    expect(rowsInput.value).toBe("");
    expect(memInput.value).toBe("");
    expect(elapsedInput.value).toBe("");
  });

  it("submitting with memory_pct=70 sends stop_when:{memory_pct:70} in the body", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const group = within(card).getByTestId("generator-stop-when");
    fireEvent.change(within(group).getByLabelText(/Stop at memory %/i), { target: { value: "70" } });
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
    expect(body.stop_when).toEqual({ memory_pct: 70 });
  });

  it("submitting with all three fields blank omits stop_when from the body", async () => {
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
    const posted = fetchMock.mock.calls.find(
      (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    )!;
    const body = JSON.parse((posted[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("stop_when");
  });

  it("populating all three fields sends them all", async () => {
    baselineFetch(fetchMock);
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const group = within(card).getByTestId("generator-stop-when");
    fireEvent.change(within(group).getByLabelText(/Stop after rows/i), { target: { value: "500" } });
    fireEvent.change(within(group).getByLabelText(/Stop at memory %/i), { target: { value: "80" } });
    fireEvent.change(within(group).getByLabelText(/Stop after seconds/i), { target: { value: "30" } });
    // Match rows so the rows-vs-stop_when.rows guard doesn't kick in on the
    // client validation side.
    fireEvent.change(within(card).getByLabelText(/^Rows$/i), { target: { value: "500" } });
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
    expect(body.stop_when).toEqual({ rows: 500, memory_pct: 80, elapsed_seconds: 30 });
  });

  it("terminal frame with stop_reason='elapsed' surfaces in the done status pill", async () => {
    baselineFetch(fetchMock, {
      run_id: "01HXELAPSED",
      done: true,
      rows_queued: 137,
      ms: 1234,
      cancelled: false,
      stop_reason: "elapsed",
    });
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      expect(screen.getByTestId("generator-stop-reason").textContent).toMatch(/time limit reached/);
    });
  });

});
