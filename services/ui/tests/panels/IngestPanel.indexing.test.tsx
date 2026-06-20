// Wave 6.41.E — IndexingProgress component covers the cases in the task
// DoD: mount-restore from localStorage anchor, no bar without anchor when
// the writer is idle, % math, and the "Indexing complete" terminal banner
// when the indexed delta reaches the rowsTotal denominator.
//
// Wave 6.41.E.fix — added coverage for the timeout-cancel bug fix, the
// auto-clear escape hatches, and the in-generation render path.
//
// Wave 6.44.D — data source switched from /admin/stream-status (xlen +
// consumed) to /admin/index-count (live FT.SEARCH * doc count).
//
// Wave 6.52.A — data source switched to /admin/stream-status reading the
// ingest worker's strictly-monotonic `consumed` write counter.
//
// Wave 6.52.C — data source reverted to /admin/index-count (FT.SEARCH *
// LIMIT 0 0). The `consumed` counter is per-worker-process and in-memory
// (resets on restart) and the generator fans 1 logical row → ~2 stream
// entries, so it is an unreliable denominator. Field renamed
// `indexCountAtAnchor` → `indexCountAtAnchor`; sample shape is now
// `{ indexCount, ts }`. pct = (indexCountNow - indexCountAtAnchor) /
// rowsTotal across in-generation and post-terminal phases. Tests use
// `indexCountState` to feed the mock `/admin/index-count` reply.

// Wave 6.44.B — anchors are partitioned by active-target label in storage.
// All tests below seed their anchor against `TEST_LABEL` and the fetch mock
// returns the same label from /redis/active-target so `useActiveTargetLabel`
// resolves to it on first poll.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import { storageKeyFor, type IndexingAnchor } from "../../src/lib/indexingState";

const TEST_LABEL = "test-label";
const STORAGE_KEY = storageKeyFor(TEST_LABEL);

function makeAnchor(partial: Omit<IndexingAnchor, "targetLabel"> & { targetLabel?: string }): IndexingAnchor {
  return { ...partial, targetLabel: partial.targetLabel ?? TEST_LABEL };
}

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

// Mutable index-count field so individual tests can advance the live
// FT.SEARCH * doc count between polls. Wave 6.52.C — IndexingProgress
// polls /admin/index-count again (reverted from the Wave 6.52.A
// /admin/stream-status `consumed` source); the outer IngestPanel
// Sensitivities tile (Wave 6.51.A) reads the same endpoint and surfaces
// whatever count this stub returns.
const indexCountState = { indexCount: 0 };

function mockFetch() {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => ({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 1 }) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => ({ used_memory: 0, used_memory_human: "0B", ms: 1 }) };
    // Wave 6.44.B — IndexingProgress reads /redis/active-target through
    // useActiveTargetLabel(); return TEST_LABEL so the hook resolves and
    // the anchor reads/writes succeed.
    if (url.endsWith("/redis/active-target") && method === "GET") {
      return {
        ok: true,
        json: async () => ({
          host: "localhost", port: 6379, tls: false, db: 0, label: TEST_LABEL,
        }),
      };
    }
    if (url.endsWith("/admin/index-count") && method === "GET") {
      return {
        ok: true,
        json: async () => ({
          ok: true, count: indexCountState.indexCount, index_name: "idx:sens:v1",
        }),
      };
    }
    // StreamStatusCard (a sibling card on the panel) still polls
    // /admin/stream-status; return a stable baseline so its render does
    // not throw. The indexing bar no longer reads from this endpoint.
    if (url.endsWith("/admin/stream-status") && method === "GET") {
      return {
        ok: true,
        json: async () => ({
          stream_key: "sensitivities:in",
          xlen: 0,
          maxlen: 0,
          peak_rate_per_sec: 0,
          retention_hours_now: 0,
          retention_hours_at_cap: 0,
          consumed: 0,
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
    indexCountState.indexCount = 0;
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

  it("renders no Indexing bar when index-count=0 and no anchor exists", async () => {
    indexCountState.indexCount = 0;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Wait for at least one index-count poll to settle.
    await waitFor(() => {
      // Run-preset card must have rendered; if the indexing bar were going to
      // appear it would be visible by now.
      expect(screen.getByTestId("ingest-preset-radiogroup")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
  });

  it("resumes from localStorage anchor and renders the correct % when indexCount > anchor", async () => {
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // 750 indexed since anchor ⇒ 75% of 1000-row denominator.
    indexCountState.indexCount = 750;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    expect(bars.length).toBeGreaterThan(0);
    const bar = bars[0]!;
    const text = within(bar).getByTestId("indexing-progress-text");
    expect(text.textContent).toMatch(/750 \/ 1,000 indexed/);
    expect(text.textContent).toMatch(/75%/);
    const pb = bar.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("75");
  });

  // Wave 6.41.E.fix4 — implicit-anchor seed removed. With index-count > 0
  // but no localStorage anchor and no active run, the bar must NOT appear:
  // the localStorage anchor and the run-status transitions are now the
  // only seed paths.
  it("(fix4) does NOT seed an implicit anchor when index-count > 0 on mount with no run", async () => {
    indexCountState.indexCount = 500;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("ingest-preset-radiogroup")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // Wave 6.44.D — completion fires when the indexed delta
  // (indexCountNow - indexCountAtAnchor) reaches rowsTotal. mockRun is set
  // to a non-null terminal state ("done") so the implicit-anchor effect
  // doesn't re-seed an anchor after the timeout clears the old one.
  it("renders 'Indexing complete' when indexCount reaches anchor + rowsTotal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 0,
      runId: "01HXRUN", status: "done",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    indexCountState.indexCount = 800;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // Indexer catches up: indexCount=1000, indexed=1000, pct=100%.
    indexCountState.indexCount = 1000;
    // Advance past the 2.5s poll cadence so the next tick observes the
    // updated index-count.
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-complete").length).toBeGreaterThan(0);
    });
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix — Fix A: the 3s completion timeout must actually fire
  // and clear the anchor. Pre-fix this leaked because the effect cleanup
  // canceled its own setTimeout via the completeShownAt dependency.
  // Wave 6.41.E.fix3 — mockRun set to "done" so the implicit-anchor effect
  // doesn't re-create an anchor immediately after the timeout clears it.
  it("(A) clears the anchor after the 3s 'Indexing complete' timeout fires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 0,
      runId: "01HXRUN", status: "done",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    indexCountState.indexCount = 800;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    indexCountState.indexCount = 1000; // ⇒ indexed=1000=rowsTotal ⇒ complete toast
    // First poll observes indexed==rowsTotal ⇒ "Indexing complete" toast.
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
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    indexCountState.indexCount = 500;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    expect(within(bars[0]!).queryByTestId("indexing-dismiss-btn")).toBeNull();
    expect(within(bars[0]!).queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  // Wave 6.44.D — index-count-plateau auto-clear (replaces the prior
  // consumed-plateau hatch). When every sample in the window already has
  // indexCount >= indexCountAtAnchor + rowsTotal AND no run is active,
  // the anchor is cleared as a fallback dismiss path. samples.length must
  // reach 2 before the hatch evaluates.
  it("(plateau) auto-clear fires when indexCount stays at-or-past target with no active run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      indexCountAtAnchor: 500,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // /admin/index-count keeps returning a doc count already at the target
    // (500 + 1000 = 1500). mockRun stays null so the plateau hatch's
    // run-inactive gate is satisfied.
    indexCountState.indexCount = 1500;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // First poll lands; bar appears (or completion toast fires immediately
    // because indexCount >= target). Either way, after a second poll the
    // plateau hatch sees samples.length >= 2 and all at-target, so it
    // clears the anchor.
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  // Wave 6.44.D — regression: after the 3s "Indexing complete" toast
  // dismisses, the bar must NOT reappear on subsequent polls even though
  // /admin/index-count keeps returning a doc count >= rowsTotal with no
  // active run.
  it("(fix4) bar does NOT reappear after 'Indexing complete' toast clears (index-count steady at target, no run)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 1000,
      runId: "01HXRUN", status: "done",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    indexCountState.indexCount = 1000;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-complete").length).toBeGreaterThan(0);
    });
    setMockRun(null);
    // 3s + ε later the completion timeout fires, anchor cleared, bar gone.
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    // Three more polls (3 × 2.5s = 7.5s) with indexCount still at-or-past
    // rowsTotal. The bar must not reappear.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2_600);
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    }
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  // Wave 6.44.D — indexing bar renders during the generator's running
  // phase using index-count math. The anchor is seeded with
  // indexCountAtAnchor=currentConsumed when the run-status transition
  // fires (indexCount=0 at run start), and rowsTotal=run.rowsTotal. As
  // indexCount grows by N rows, pct grows by N/rowsTotal.
  it("(E) renders during run.status='running' with index-count math", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 500, elapsedMs: 1000, rowsPerSec: 500,
      runId: "01HXRUN", status: "running",
    });
    indexCountState.indexCount = 0; // baseline at run start
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Anchor seeds at indexCountAtAnchor=0 once the first poll lands.
    await waitFor(() => {
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
      expect(stored?.indexCountAtAnchor).toBe(0);
      expect(stored?.rowsTotal).toBe(1000);
    });
    // Indexer ingests 400 rows ⇒ indexed=400, pct=400/1000=40%.
    indexCountState.indexCount = 400;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const bars = screen.getAllByTestId("indexing-progress");
      const text = within(bars[0]!).getByTestId("indexing-progress-text");
      expect(text.textContent).toMatch(/400 \/ 1,000 indexed/);
      expect(text.textContent).toMatch(/40%/);
      const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("40");
    });
    vi.useRealTimers();
  });

  // Wave 6.44.D — the single anchor created at run start must persist
  // across the running→done transition unchanged so the bar keeps growing
  // smoothly toward 100% rather than jumping.
  it("(E) anchor persists unchanged across the running→done transition", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 1000,
      runId: "01HXRUN", status: "running",
    });
    indexCountState.indexCount = 0;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Wait for the anchor to be seeded at indexCount=0.
    await waitFor(() => {
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
      expect(stored?.indexCountAtAnchor).toBe(0);
      expect(stored?.rowsTotal).toBe(1000);
    });
    // Advance to 40% indexed pre-transition.
    indexCountState.indexCount = 400;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const pb = screen.getAllByTestId("indexing-progress")[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("40");
    });
    // Flip run to done; indexer continues ⇒ indexCount=700.
    // pct = (700 - 0) / 1000 = 70%; anchor is unchanged.
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 2000, rowsPerSec: 500,
      runId: "01HXRUN", status: "done",
    });
    indexCountState.indexCount = 700;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const pb = screen.getAllByTestId("indexing-progress")[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("70");
    });
    const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
    expect(stored).not.toBeNull();
    expect(stored!.indexCountAtAnchor).toBe(0);
    expect(stored!.rowsTotal).toBe(1000);
    vi.useRealTimers();
  });

  // Wave 6.44.D — when the live FT.SEARCH count drops below the anchor's
  // baseline (FLUSHDB, index rebuild, or fresh sens-index version), the
  // bar must re-anchor at the new value and resume from 0% rather than
  // clamping forever or going negative.
  it("(restart) re-anchors when indexCount drops below the stored baseline (index rebuild)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      indexCountAtAnchor: 500,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    indexCountState.indexCount = 750; // 250 indexed since anchor ⇒ 25%
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      const bars = screen.queryAllByTestId("indexing-progress");
      expect(bars.length).toBeGreaterThan(0);
      const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("25");
    });
    // Index rebuild: FT.SEARCH count drops to 50 (well below the 500
    // baseline). Restart-detection effect re-seeds indexCountAtAnchor=50.
    indexCountState.indexCount = 50;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
      expect(stored).not.toBeNull();
      expect(stored!.indexCountAtAnchor).toBe(50);
    });
    // pct drops to 0% (indexed since new anchor = 0).
    const bars = screen.getAllByTestId("indexing-progress");
    const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("0");
    vi.useRealTimers();
  });

  // Wave 6.44.D — tab reload mid-run. The persisted anchor in localStorage
  // is the source of truth across reloads; on remount the bar should resume
  // from the persisted baseline and compute pct off the live index-count
  // without re-creating the anchor.
  it("(reload) tab reload mid-run resumes from persisted v2 anchor without rewriting it", async () => {
    const anchorTs = Date.now() - 5_000;
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 10_000,
      indexCountAtAnchor: 1_000,
      anchorTs,
      lastSeenAt: anchorTs,
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    indexCountState.indexCount = 4_000; // 3000 indexed since anchor ⇒ 30%
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("30");
    const text = within(bars[0]!).getByTestId("indexing-progress-text");
    expect(text.textContent).toMatch(/3,000 \/ 10,000 indexed/);
    // Anchor in localStorage is unchanged: same baseline, same anchorTs.
    const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
    expect(stored).not.toBeNull();
    expect(stored!.indexCountAtAnchor).toBe(1_000);
    expect(stored!.rowsTotal).toBe(10_000);
    expect(stored!.anchorTs).toBe(anchorTs);
  });

  // Wave 6.44.D — bar shows 0% (not NaN, not hidden) when indexCount is
  // exactly at the anchor baseline and rowsTotal > 0 (run just started,
  // no indexing has happened yet).
  it("(E) shows 0% (not NaN, not hidden) when no rows have been indexed since the anchor", async () => {
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    setMockRun({
      rowsTotal: 1000, rowsDone: 0, elapsedMs: 0, rowsPerSec: 0,
      runId: "01HXRUN", status: "running",
    });
    indexCountState.indexCount = 0;
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

  // Wave 6.44.E — pressing "Stop all runs" mid-stream flips the run from
  // "running" → "cancelled" before the indexer reaches anchor + rowsTotal.
  // The bar must disappear on the next render (and the v2 anchor must be
  // hard-cleared from localStorage) instead of sitting stranded until tab
  // close.
  it("(6.44.E) cancel mid-run with indexed < rowsTotal hard-clears the bar", async () => {
    setMockRun({
      rowsTotal: 100_000, rowsDone: 30_000, elapsedMs: 1_000, rowsPerSec: 30_000,
      runId: "01HXRUN", status: "running",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 100_000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    indexCountState.indexCount = 30_000; // 30% indexed at cancel time
    vi.stubGlobal("fetch", mockFetch());
    const { rerender } = renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // User clicks "Stop all runs" ⇒ run.status flips to "cancelled".
    setMockRun({
      rowsTotal: 100_000, rowsDone: 30_000, elapsedMs: 1_000, rowsPerSec: 30_000,
      runId: "01HXRUN", status: "cancelled",
    });
    rerender(
      <MemoryRouter>
        <GeneratorRunProvider>
          <IngestPanel />
        </GeneratorRunProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    // Anchor was hard-cleared from localStorage so a page refresh would
    // not resurrect the stranded bar.
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // Wave 6.44.F + 6.52.B — defensive auto-clear, now gated on atTarget.
  // When `run` transitions from non-null to null while the index has
  // already caught up (`indexCount - indexCountAtAnchor >= rowsTotal`), the
  // backstop resets the indexing state so the bar doesn't sit stranded
  // after the run is dropped from context. Preserves the race-fix from the
  // original Wave 6.44.F test. Uses `status: "done"` for the present-run
  // state so the cancel-effect's `isStartingRun` branch does NOT wipe and
  // re-seed the pre-seeded anchor at the current index-count (which would
  // make `indexed` come out as 0 and fail the atTarget check).
  it("(6.44.F/6.52.B) run going null with index at target clears the anchor", async () => {
    setMockRun({
      rowsTotal: 100_000, rowsDone: 100_000, elapsedMs: 2_000, rowsPerSec: 50_000,
      runId: "01HXATTARGET", status: "done",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXATTARGET",
      rowsTotal: 100_000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // Writes have already caught up by the time the run is evicted.
    indexCountState.indexCount = 100_000;
    vi.stubGlobal("fetch", mockFetch());
    const { rerender } = renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // Registry evicts the run; index-count already at target.
    setMockRun(null);
    rerender(
      <MemoryRouter>
        <GeneratorRunProvider>
          <IngestPanel />
        </GeneratorRunProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    // Anchor was hard-cleared from localStorage by the gated backstop.
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // Wave 6.52.B — when `run` is evicted from context (registry-eviction,
  // grace-expiry, Stop-all-runs auto-dismiss) while the index has NOT
  // caught up, the indexing bar MUST persist so users can see indexing
  // finish. FT.SEARCH can lag the generator by many seconds; clearing on
  // run-eviction killed the bar at e.g. 60%. Cleanup falls through to the
  // plateau-hatch effect (~25s window) or to the completion-toast effect
  // once the index catches up.
  it("(6.52.B) run going null while index-count < target keeps the bar visible", async () => {
    setMockRun({
      rowsTotal: 100_000, rowsDone: 100_000, elapsedMs: 2_000, rowsPerSec: 50_000,
      runId: "01HXLAG", status: "running",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXLAG",
      rowsTotal: 100_000,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // Index is mid-build at 60% of target when the run is evicted.
    indexCountState.indexCount = 60_000;
    vi.stubGlobal("fetch", mockFetch());
    const { rerender } = renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // Registry evicts the run before the index catches up.
    setMockRun(null);
    rerender(
      <MemoryRouter>
        <GeneratorRunProvider>
          <IngestPanel />
        </GeneratorRunProvider>
      </MemoryRouter>,
    );
    // Bar must still be present; indexCount (60K) < target (100K).
    // Spin for a few render cycles to ensure no defer-clear effect fires.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    // Anchor must remain in localStorage so a refresh resumes the bar.
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  // Wave 6.44.D — indexing pct grows monotonically as the live FT.SEARCH
  // count increases against the rowsTotal denominator. Mirrors real
  // production rates: ~30K rows/s indexing on a 10M-row target.
  it("(monotonic) in-generation pct grows monotonically as indexCount advances", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rowsTotal = 10_000_000;
    const drainPerTick = 30_000; // ~30K rows/s × 1 tick
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal,
      indexCountAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    setMockRun({
      rowsTotal, rowsDone: 1_000_000, elapsedMs: 1_000, rowsPerSec: 1_000_000,
      runId: "01HXRUN", status: "running",
    });
    let indexed = drainPerTick;
    indexCountState.indexCount = indexed;
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
    // Nine more ticks; indexCount advances by ~30K each tick.
    for (let i = 0; i < 9; i++) {
      indexed += drainPerTick;
      indexCountState.indexCount = indexed;
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
    // Final pct ≈ 300K / 10M = 3%.
    expect(observed[observed.length - 1]).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});
