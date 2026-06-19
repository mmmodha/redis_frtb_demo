// Wave 6.41.E — IndexingProgress component covers the cases in the task
// DoD: mount-restore from localStorage anchor, no bar without anchor at
// xlen=0, % math, and the "Indexing complete" terminal banner when xlen
// drains to 0 with an active anchor.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import { GeneratorRunProvider } from "../../src/context/GeneratorRunContext";
import { STORAGE_KEY, type IndexingAnchor } from "../../src/lib/indexingState";

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

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k: string) { map.delete(k); },
    setItem(k: string, v: string) { map.set(k, String(v)); },
  };
}

// Mutable xlen so individual tests can advance "consumer drain" by editing
// streamState.xlen between polls.
const streamState = { xlen: 0 };

function mockFetch() {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => ({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 1 }) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => ({ used_memory: 0, used_memory_human: "0B", ms: 1 }) };
    if (url.endsWith("/admin/stream-status") && method === "GET") {
      return {
        ok: true,
        json: async () => ({
          stream_key: "frtb:in", xlen: streamState.xlen, maxlen: 0,
          peak_rate_per_sec: 0, retention_hours_now: 0, retention_hours_at_cap: 0,
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <GeneratorRunProvider>
        <IngestPanel />
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
}

const originalLocalStorage = globalThis.localStorage;

describe("<IndexingProgress /> — Wave 6.41.E", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: makeMemoryStorage(),
      configurable: true,
      writable: true,
    });
    streamState.xlen = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  it("renders no Indexing bar when xlen=0 and no anchor exists", async () => {
    streamState.xlen = 0;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Wait for at least one stream-status poll to settle.
    await waitFor(() => {
      // Run-preset card must have rendered; if the indexing bar were going to
      // appear it would be visible by now.
      expect(screen.getByTestId("ingest-preset-radiogroup")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
  });

  it("resumes from localStorage anchor and renders the correct % when xlen > 0", async () => {
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      anchorXlen: 1000,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 250; // 75% indexed
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    expect(bars.length).toBeGreaterThan(0);
    const bar = bars[0]!;
    const text = within(bar).getByTestId("indexing-progress-text");
    expect(text.textContent).toMatch(/250 rows remaining/);
    expect(text.textContent).toMatch(/75%/);
    const pb = bar.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("75");
  });

  it("renders an implicit anchor when xlen > 0 on mount with no prior anchor", async () => {
    streamState.xlen = 500;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    expect(bars.length).toBeGreaterThan(0);
    // implicit anchor uses currentXlen as both rowsTotal and anchorXlen ⇒ 0%
    const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("0");
    // anchor should now be persisted to localStorage so a refresh would
    // resume from the same baseline.
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("renders 'Indexing complete' when xlen drops to 0 with an active anchor", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      anchorXlen: 1000,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 200;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // Consumer drains the stream.
    streamState.xlen = 0;
    // Advance past the 2.5s poll cadence so the next tick observes xlen=0.
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-complete").length).toBeGreaterThan(0);
    });
    vi.useRealTimers();
  });
});
