// Wave 6.41.E — IndexingProgress component covers the cases in the task
// DoD: mount-restore from localStorage anchor, no bar without anchor at
// xlen=0, % math, and the "Indexing complete" terminal banner when xlen
// drains to 0 with an active anchor.
//
// Wave 6.41.E.fix — added coverage for the timeout-cancel bug fix, the
// C/D auto-clear escape hatches, and the E in-generation render path.
//
// Wave 6.41.E.fix2 — denominator switched to run.rowsTotal so the bar
// shows monotonic progress toward the run target during generation; the
// × dismiss button was removed (auto-clear handles dead-stream cases).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
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

// Wave 6.41.E.fix — controllable mock for the generator-run context. Tests
// that need to drive run state (E in-generation view) reassign mockRun
// between renders; the existing tests leave it at null which matches the
// prior "no run" default of <GeneratorRunProvider />.
type MockRun = {
  rowsTotal: number;
  rowsDone: number;
  elapsedMs: number;
  rowsPerSec: number;
  runId: string | null;
  status: "running" | "cancelling" | "done" | "cancelled" | "error";
} | null;
let mockRun: MockRun = null;
function setMockRun(r: MockRun): void { mockRun = r; }
vi.mock("../../src/context/GeneratorRunContext", () => ({
  GeneratorRunProvider: ({ children }: { children: any }) => children,
  useGeneratorRun: () => ({
    run: mockRun,
    error: null,
    startRun: () => {},
    cancelRun: () => {},
    clearRun: () => {},
  }),
}));

// Re-import after the mock is registered so the named export resolves to
// the stub above.
import { GeneratorRunProvider } from "../../src/context/GeneratorRunContext";

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
    setMockRun(null);
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

  // Wave 6.41.E.fix — Fix A: the 3s completion timeout must actually fire
  // and clear the anchor. Pre-fix this leaked because the effect cleanup
  // canceled its own setTimeout via the completeShownAt dependency.
  it("(A) clears the anchor after the 3s 'Indexing complete' timeout fires", async () => {
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
    streamState.xlen = 0;
    // First poll observes xlen=0 ⇒ "Indexing complete" toast scheduled.
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-complete").length).toBeGreaterThan(0);
    });
    // 3s later the timeout must fire and clear the anchor + hide the bar.
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix2 — the × dismiss button was removed entirely; auto-
  // clear (C/D below) handles dead-stream cases and the 24h TTL on the
  // anchor handles long-term staleness.
  it("(fix2) no × dismiss button is rendered", async () => {
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      anchorXlen: 1000,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 500;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    expect(within(bars[0]!).queryByTestId("indexing-dismiss-btn")).toBeNull();
    expect(within(bars[0]!).queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  // Wave 6.41.E.fix — Fix C: 2+ trailing xlen=0 polls and no active run ⇒
  // hard-clear (no 3s toast). Anchor.anchorXlen > 0 alone would also be
  // caught by D, so we use a window that mixes a positive sample with
  // trailing zeros to isolate C.
  it("(C) hard-clears after 2+ consecutive xlen=0 polls with no active run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      anchorXlen: 1000,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 50;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // Two consecutive xlen=0 polls; the first poll's positive sample keeps
    // D's "all samples in window are zero" check from firing.
    streamState.xlen = 0;
    await vi.advanceTimersByTimeAsync(2_600);
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix — Fix D: FLUSHDB heuristic. All samples in window are
  // xlen=0 AND anchor.anchorXlen > 0 ⇒ clear immediately, no toast.
  it("(D) hard-clears when anchorXlen > 0 and every sample in the window is zero", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      anchorXlen: 1000,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // xlen is already 0 from the start; every sample in the window will be 0.
    streamState.xlen = 0;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Bar appears briefly (anchor restored) then the second xlen=0 poll
    // triggers D and the bar is hard-cleared.
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix2 — indexing bar renders during the generator's running
  // phase and uses (rowsAdded - xlen) / rowsTotal as the denominator so
  // the bar tracks progress toward the run target (not "indexing caught up
  // to producer", which stays near 0% because the producer is ~50× faster).
  it("(E) renders during run.status='running' with (rowsAdded - xlen)/rowsTotal denominator", async () => {
    setMockRun({
      rowsTotal: 1000, rowsDone: 500, elapsedMs: 1000, rowsPerSec: 500,
      runId: "01HXRUN", status: "running",
    });
    streamState.xlen = 100; // indexed = 500 - 100 = 400; pct = 400/1000 = 40%
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    const bar = bars[0]!;
    const text = within(bar).getByTestId("indexing-progress-text");
    expect(text.textContent).toMatch(/400 \/ 1,000 indexed/);
    expect(text.textContent).toMatch(/40%/);
    const pb = bar.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("40");
    // No anchor should be persisted while the in-generation view is active.
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // Wave 6.41.E.fix — Fix E: clean transition from the in-generation
  // denominator to the peak-xlen anchor when the run reaches "done". The
  // bar must stay visible across the transition.
  it("(E) transitions cleanly from in-generation view to peak-xlen anchor on run→done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 1000,
      runId: "01HXRUN", status: "running",
    });
    streamState.xlen = 600; // peak observed by the poll
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Wait for the in-generation view to settle (rowsAdded=1000, xlen=600 ⇒
    // 40% indexed).
    await waitFor(() => {
      const bars = screen.queryAllByTestId("indexing-progress");
      expect(bars.length).toBeGreaterThan(0);
      const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("40");
    });
    // Flip the run to "done" and let the next poll observe xlen=300. The
    // terminal seed picks max(peak=600, currentXlen=300, rowsTotal=1000) =
    // 1000 ⇒ anchored pct = (1000-300)/1000 = 70%.
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 2000, rowsPerSec: 500,
      runId: "01HXRUN", status: "done",
    });
    streamState.xlen = 300;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const bars = screen.queryAllByTestId("indexing-progress");
      expect(bars.length).toBeGreaterThan(0);
      const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("70");
    });
    const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
    expect(stored).not.toBeNull();
    expect(stored!.anchorXlen).toBe(1000);
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix — Fix E: edge case rowsAdded === 0 must show 0%, not
  // NaN or a hidden bar.
  it("(E) shows 0% (not NaN, not hidden) when run.rowsDone === 0", async () => {
    setMockRun({
      rowsTotal: 1000, rowsDone: 0, elapsedMs: 0, rowsPerSec: 0,
      runId: "01HXRUN", status: "running",
    });
    streamState.xlen = 0;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    const bar = bars[0]!;
    const pb = bar.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("0");
    const text = within(bar).getByTestId("indexing-progress-text");
    expect(text.textContent).not.toMatch(/NaN/);
    expect(text.textContent).toMatch(/0%/);
  });

  // Wave 6.41.E.fix2 — with the new rowsTotal denominator, indexing pct
  // grows monotonically across the entire generation phase. Time-series
  // mirrors real production rates: producer ~1M/s, consumer ~30K/s, on a
  // 10M-row target. Old formula `(rowsAdded - xlen)/rowsAdded` would have
  // every tick pinned at ~0% (xlen ≈ rowsAdded throughout).
  it("(fix2) in-generation pct grows monotonically on a realistic time-series", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rowsTotal = 10_000_000;
    const producePerTick = 1_000_000; // ~1M rows/s × 1 tick
    const drainPerTick = 30_000;      // ~30K rows/s × 1 tick (~33× slower)
    let rowsDone = producePerTick;
    let indexed = drainPerTick;
    setMockRun({
      rowsTotal, rowsDone, elapsedMs: 1_000, rowsPerSec: producePerTick,
      runId: "01HXRUN", status: "running",
    });
    streamState.xlen = rowsDone - indexed;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // Read raw pct from the fill width so sub-integer growth is observable.
    const readPct = (): number => {
      const bar = screen.getAllByTestId("indexing-progress")[0]!;
      const fill = bar.querySelector(".indexing-progress__fill") as HTMLElement;
      return parseFloat(fill.style.width);
    };
    const observed: number[] = [readPct()];
    // Nine more ticks: producer adds ~1M, consumer adds ~30K each tick.
    for (let i = 0; i < 9; i++) {
      rowsDone += producePerTick;
      indexed += drainPerTick;
      setMockRun({
        rowsTotal, rowsDone, elapsedMs: 1_000 * (i + 2), rowsPerSec: producePerTick,
        runId: "01HXRUN", status: "running",
      });
      streamState.xlen = rowsDone - indexed;
      await vi.advanceTimersByTimeAsync(2_600);
      await waitFor(() => {
        expect(Number.isFinite(readPct())).toBe(true);
      });
      observed.push(readPct());
    }
    // Strictly monotonic growth across all 10 samples.
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]).toBeGreaterThan(observed[i - 1]!);
    }
    // Final pct ≈ 300K / 10M = 3%; far above the ~0% the old formula gave.
    expect(observed[observed.length - 1]).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});
