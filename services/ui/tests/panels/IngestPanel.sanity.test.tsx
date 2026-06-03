// Wave 5.20a — pre-submit sanity check, "Generate 200 rows" default button,
// collapsible advanced section, and the sparkline numeric labels.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel, computeSanity } from "../../src/panels/IngestPanel";
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
  EnterpriseCallout: ({ signal, children }: any) => (<aside data-signal={signal}>{children}</aside>),
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
function memoryResponse(extra: Record<string, number> = {}) {
  return { used_memory: 0, used_memory_human: "0B", ms: 1, ...extra };
}
function generatorCard() {
  return screen.getAllByTestId("panel-card").find((el) => el.getAttribute("data-title") === "Synthetic generator")!;
}

// Wave 5.20c — generator endpoint switched from POST /generator/start (JSON)
// to POST /generator/start/stream (SSE). Mock returns a single terminal frame
// so the streaming client resolves immediately.
function sseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
}

function mockFetch(memBody: Record<string, number> = {}, dbsize = 0) {
  const fetchMock = vi.fn();
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(dbsize) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse(memBody) };
    if (url.endsWith("/generator/start/stream") && method === "POST")
      return { ok: true, body: sseBody([{ run_id: "01HX", done: true, rows_queued: 200, ms: 5, cancelled: false }]) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("computeSanity (Wave 5.20a)", () => {
  it("returns null when both maxmemory and total_system_memory are 0/unknown", () => {
    expect(computeSanity(200, { used_memory: 0, maxmemory_bytes: 0, total_system_memory_bytes: 0, dbsize: 0 })).toBeNull();
  });
  it("returns null when estimate is below 70% of headroom", () => {
    // 200 rows × 1500 = 300_000; maxmemory 1GB → headroom 1GB → ~0.03%.
    expect(computeSanity(200, { used_memory: 0, maxmemory_bytes: 1_000_000_000, total_system_memory_bytes: 0, dbsize: 0 })).toBeNull();
  });
  it("returns warn variant at 70-100% of headroom", () => {
    // 2000 rows × 1500 = 3MB; maxmemory 3.75MB → headroom 3.75MB → 80%.
    const r = computeSanity(2000, { used_memory: 0, maxmemory_bytes: 3_750_000, total_system_memory_bytes: 0, dbsize: 0 });
    expect(r).not.toBeNull();
    expect(r!.variant).toBe("warn");
    expect(r!.pct).toBeGreaterThanOrEqual(70);
    expect(r!.pct).toBeLessThanOrEqual(100);
  });
  it("returns block variant when estimate exceeds headroom", () => {
    // 2000 rows × 1500 = 3MB; maxmemory 1MB → headroom 1MB → 300%.
    const r = computeSanity(2000, { used_memory: 0, maxmemory_bytes: 1_000_000, total_system_memory_bytes: 0, dbsize: 0 });
    expect(r).not.toBeNull();
    expect(r!.variant).toBe("block");
    expect(r!.pct).toBeGreaterThan(100);
    expect(r!.suggestedRows).toBeGreaterThan(0);
    expect(r!.suggestedRows).toBeLessThan(2000);
  });
  it("uses total_system_memory × 0.7 when maxmemory is unset", () => {
    // 2000 rows × 1500 = 3MB; total_sys 5.36MB → headroom 0.7*5.36MB ≈ 3.75MB → ~80%.
    const r = computeSanity(2000, { used_memory: 0, maxmemory_bytes: 0, total_system_memory_bytes: 5_357_143, dbsize: 0 });
    expect(r).not.toBeNull();
    expect(r!.variant).toBe("warn");
  });
  it("falls back to 1500 bytes/row when dbsize is 0", () => {
    const r = computeSanity(100, { used_memory: 0, maxmemory_bytes: 200_000, total_system_memory_bytes: 0, dbsize: 0 });
    // 100 * 1500 = 150_000; headroom 200_000 → 75% → warn.
    expect(r!.variant).toBe("warn");
  });
  it("derives bytes_per_row from used_memory / dbsize when available", () => {
    // 2 KB/row × 200 rows = 400_000; headroom 500_000 → 80% → warn.
    const r = computeSanity(200, { used_memory: 200_000, maxmemory_bytes: 700_000, total_system_memory_bytes: 0, dbsize: 100 });
    expect(r!.variant).toBe("warn");
    expect(r!.bytesPerRow).toBe(2000);
  });
});

describe("<IngestPanel /> synthetic generator (Wave 5.20a)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("renders the 'Generate' primary button (Wave 5.52 simple-mode submit)", async () => {
    fetchMock = mockFetch();
    renderPanel();
    const card = await waitFor(() => generatorCard());
    expect(within(card).getByTestId("generator-generate-btn")).toBeInTheDocument();
  });

  it("'Generate' (simple mode) POSTs the auto-derived body to /generator/start/stream", async () => {
    fetchMock = mockFetch();
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
    // Wave 5.52 — defaults (200 rows · 60/30/10 mix) auto-derive a full body.
    expect(body.class_split).toEqual({ GIRR: 120, Equity: 60, FX: 20 });
    expect(body.sensitivity_types).toEqual(["Delta", "Vega"]);
    expect(body.trade_pool_size).toBe(50);
    expect(body.factor_pool_size).toBe(8);
    expect(body.stop_when).toEqual({ rows: 200, memory_pct: 75, elapsed_seconds: 600 });
    expect(typeof body.seed).toBe("number");
  });

  it("advanced options are collapsed by default and toggle on click", async () => {
    fetchMock = mockFetch();
    renderPanel();
    const card = await waitFor(() => generatorCard());
    const toggle = within(card).getByTestId("generator-advanced-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("renders sparkline numeric labels (now/min/max) on both charts", async () => {
    fetchMock = mockFetch();
    renderPanel();
    await waitFor(() => screen.getByTestId("chart-throughput-labels"));
    const tputLabels = screen.getByTestId("chart-throughput-labels");
    expect(tputLabels.textContent).toMatch(/now/i);
    expect(tputLabels.textContent).toMatch(/min/i);
    expect(tputLabels.textContent).toMatch(/max/i);
    const memLabels = screen.getByTestId("chart-memory-labels");
    expect(memLabels.textContent).toMatch(/now/i);
    expect(memLabels.textContent).toMatch(/min/i);
    expect(memLabels.textContent).toMatch(/max/i);
  });

  it("warning modal renders at 70-100% headroom; Proceed submits", async () => {
    // 200 rows * 1500 bpr = 300_000; maxmemory 375_000 → ~80% warn.
    fetchMock = mockFetch({ maxmemory_bytes: 375_000, total_system_memory_bytes: 0, dbsize: 0 });
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    const modal = await screen.findByTestId("sanity-modal-warn");
    expect(modal).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole("button", { name: /proceed/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
  });

  it("block modal renders when estimate exceeds headroom; Override still submits", async () => {
    // 200 rows * 1500 bpr = 300_000; maxmemory 100_000 → 300% block.
    fetchMock = mockFetch({ maxmemory_bytes: 100_000, total_system_memory_bytes: 0, dbsize: 0 });
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    const modal = await screen.findByTestId("sanity-modal-block");
    expect(within(modal).getByRole("button", { name: /override/i })).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: /use \d+ rows/i })).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole("button", { name: /override/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
  });

  it("Cancel on modal aborts the submit (no POST issued)", async () => {
    fetchMock = mockFetch({ maxmemory_bytes: 100_000, total_system_memory_bytes: 0, dbsize: 0 });
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    const modal = await screen.findByTestId("sanity-modal-block");
    fireEvent.click(within(modal).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByTestId("sanity-modal-block")).not.toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      (c) => /\/generator\/start(\/stream)?$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("submit skips the modal when memory data is unknown (graceful fallback)", async () => {
    // memoryResponse with no maxmemory_bytes/total_system_memory_bytes ⇒ both 0 ⇒ null.
    fetchMock = mockFetch();
    renderPanel();
    const card = await waitFor(() => generatorCard());
    fireEvent.click(within(card).getByTestId("generator-generate-btn"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/generator\/start\/stream$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    expect(screen.queryByTestId("sanity-modal-warn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sanity-modal-block")).not.toBeInTheDocument();
  });
});

describe("generator-form dark-theme readability (Wave 5.20a)", () => {
  // We can't compute external CSS in jsdom, so assert the stylesheet source
  // uses the dark-mode tokens from tokens.css instead of the old --color-*
  // fallbacks that resolved to white.
  it("uses --redis-bg-tertiary / --redis-text-primary / --redis-border-primary for inputs and fieldsets", () => {
    const cssPath = resolve(__dirname, "../../src/styles/ingest.css");
    const css = readFileSync(cssPath, "utf8");
    // No leftover fallback to white backgrounds.
    expect(css).not.toMatch(/var\(--color-surface,\s*#fff\)/);
    expect(css).not.toMatch(/var\(--color-border,\s*#d0d4d9\)/);
    // Inputs and groups use the dark tokens.
    expect(css).toMatch(/\.generator-form__row input[\s\S]*?background:\s*var\(--redis-bg-tertiary\)/);
    expect(css).toMatch(/\.generator-form__row input[\s\S]*?color:\s*var\(--redis-text-primary\)/);
    expect(css).toMatch(/\.generator-form__group[\s\S]*?border:\s*1px solid var\(--redis-border-primary\)/);
    expect(css).toMatch(/\.generator-form__group[\s\S]*?background:\s*var\(--redis-bg-tertiary\)/);
  });
});
