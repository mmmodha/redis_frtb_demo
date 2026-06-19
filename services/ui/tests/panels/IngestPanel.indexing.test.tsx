// Wave 6.41.E — IndexingProgress component covers the cases in the task
// DoD: mount-restore from localStorage anchor, no bar without anchor at
// xlen=0, % math, and the "Indexing complete" terminal banner when the
// indexed delta reaches the rowsTotal denominator.
//
// Wave 6.41.E.fix — added coverage for the timeout-cancel bug fix, the
// C/D auto-clear escape hatches, and the E in-generation render path.
//
// Wave 6.41.E.fix2 — denominator switched to run.rowsTotal so the bar
// shows monotonic progress toward the run target during generation; the
// × dismiss button was removed (auto-clear handles dead-stream cases).
//
// Wave 6.41.E.fix3 — data source switched from `xlen` to the monotonic
// `consumed` counter (`/admin/stream-status.consumed`, published by
// services/ingest). Single-phase anchor: pct =
// (consumedNow - consumedAtAnchor) / rowsTotal across in-generation and
// post-terminal phases. xlen is still polled and used only by the C/D
// auto-clear heuristics. New tests cover restart re-anchoring and tab
// reload mid-run.
//
// Wave 6.41.E.fix4 — implicit-anchor seed and xlen===0 auto-clear are
// gone (re-fired immediately on maxlen=0 streams, pinning the bar at
// 0% after the toast). Replaced with a consumed-plateau auto-clear.
// Tests for the old implicit-anchor and C/D xlen-zero paths were
// removed; new tests cover (a) no-reappear after toast even though
// xlen stays positive and consumed stays at-or-above target, and
// (b) consumed-plateau hatch.

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

// Mutable stream-status fields so individual tests can advance consumer
// progress by editing streamState between polls. Wave 6.41.E.fix3 — added
// `consumed` (monotonic) alongside the original `xlen` (still surfaced for
// the C/D auto-clear heuristics).
const streamState = { xlen: 0, consumed: 0 };

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
    if (url.endsWith("/admin/stream-status") && method === "GET") {
      return {
        ok: true,
        json: async () => ({
          stream_key: "frtb:in", xlen: streamState.xlen, maxlen: 0,
          peak_rate_per_sec: 0, retention_hours_now: 0, retention_hours_at_cap: 0,
          consumed: streamState.consumed,
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
    streamState.consumed = 0;
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

  it("resumes from localStorage anchor and renders the correct % when consumed > anchor", async () => {
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      consumedAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // 750 indexed since anchor ⇒ 75% of 1000-row denominator. xlen is kept
    // positive so the C/D auto-clear heuristics stay dormant.
    streamState.consumed = 750;
    streamState.xlen = 250;
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

  // Wave 6.41.E.fix4 — implicit-anchor seed removed. With xlen > 0 but no
  // localStorage anchor and no active run, the bar must NOT appear: the
  // localStorage anchor and the run-status transitions are now the only
  // seed paths.
  it("(fix4) does NOT seed an implicit anchor when xlen > 0 on mount with no run", async () => {
    streamState.xlen = 500;
    streamState.consumed = 0;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("ingest-preset-radiogroup")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // Wave 6.41.E.fix3 — completion is no longer driven by xlen=0 (which is
  // unreachable on unbounded streams); it now fires when the indexed delta
  // (consumedNow - consumedAtAnchor) reaches rowsTotal. xlen is held > 0
  // so the C/D auto-clear escape hatches stay dormant. mockRun is set to
  // a non-null terminal state ("done") so the implicit-anchor effect (which
  // triggers when run===null AND xlen>0) doesn't re-seed an anchor after
  // the timeout clears the old one.
  it("renders 'Indexing complete' when consumed reaches anchor + rowsTotal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 0,
      runId: "01HXRUN", status: "done",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      consumedAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 200;
    streamState.consumed = 800;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    // Consumer catches up: consumed=1000, indexed=1000, pct=100%.
    streamState.consumed = 1000;
    // Advance past the 2.5s poll cadence so the next tick observes the
    // updated consumed counter.
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
      consumedAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 200;
    streamState.consumed = 800;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-progress").length).toBeGreaterThan(0);
    });
    streamState.consumed = 1000; // ⇒ indexed=1000=rowsTotal ⇒ complete toast
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
      consumedAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 500;
    streamState.consumed = 500;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    const bars = await screen.findAllByTestId("indexing-progress");
    expect(within(bars[0]!).queryByTestId("indexing-dismiss-btn")).toBeNull();
    expect(within(bars[0]!).queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  // Wave 6.41.E.fix4 — consumed-plateau auto-clear (replaces the prior C/D
  // xlen===0 hatches, which never fired on unbounded streams). When every
  // sample in the window already has consumed >= consumedAtAnchor +
  // rowsTotal AND no run is active, the anchor is cleared as a fallback
  // dismiss path. samples.length must reach 2 before the hatch evaluates.
  it("(fix4) consumed-plateau auto-clear fires when consumed stays at-or-past target with no active run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      consumedAtAnchor: 500,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // Stream-status keeps returning xlen > 0 (unbounded stream) and
    // consumed already at the target (500 + 1000 = 1500). mockRun stays
    // null so the plateau hatch's run-inactive gate is satisfied.
    streamState.xlen = 10_000;
    streamState.consumed = 1500;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // First poll lands; bar appears (or completion toast fires immediately
    // because consumed >= target). Either way, after a second poll the
    // plateau hatch sees samples.length >= 2 and all at-target, so it
    // clears the anchor.
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix4 — regression: after the 3s "Indexing complete" toast
  // dismisses, the bar must NOT reappear on subsequent polls even though
  // /admin/stream-status keeps returning xlen > 0 and consumed >=
  // rowsTotal with no active run. Pre-fix the implicit-anchor effect
  // re-seeded an anchor every poll and pinned the bar at 0%.
  it("(fix4) bar does NOT reappear after 'Indexing complete' toast clears (unbounded stream, no run)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 1000,
      runId: "01HXRUN", status: "done",
    });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      consumedAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    // Live-evidence shape: maxlen=0 stream where xlen is cumulative-ever
    // and consumed has caught up to rowsTotal.
    streamState.xlen = 100_000;
    streamState.consumed = 1000;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      expect(screen.queryAllByTestId("indexing-complete").length).toBeGreaterThan(0);
    });
    // Simulate the user's "no active runs" condition from the regression
    // (drives the implicit-anchor effect pre-fix4).
    setMockRun(null);
    // 3s + ε later the completion timeout fires, anchor cleared, bar gone.
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => {
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    // Three more polls (3 × 2.5s = 7.5s) with xlen still > 0 and consumed
    // still at-or-past rowsTotal. Pre-fix4 the implicit-anchor effect
    // would have re-created an anchor on the very next tick.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2_600);
      expect(screen.queryByTestId("indexing-progress")).not.toBeInTheDocument();
    }
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix3 — indexing bar renders during the generator's running
  // phase using consumed-counter math. The anchor is seeded with
  // consumedAtAnchor=currentConsumed when the run-status transition fires
  // (consumed=0 at run start), and rowsTotal=run.rowsTotal. As consumed
  // grows by N rows, pct grows by N/rowsTotal.
  it("(E) renders during run.status='running' with consumed-counter math", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 500, elapsedMs: 1000, rowsPerSec: 500,
      runId: "01HXRUN", status: "running",
    });
    streamState.xlen = 500;
    streamState.consumed = 0; // baseline at run start
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Anchor seeds at consumedAtAnchor=0 once the first poll lands.
    await waitFor(() => {
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
      expect(stored?.consumedAtAnchor).toBe(0);
      expect(stored?.rowsTotal).toBe(1000);
    });
    // Consumer drains 400 rows ⇒ indexed=400, pct=400/1000=40%.
    streamState.consumed = 400;
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

  // Wave 6.41.E.fix3 — the prior two-phase design (in-generation view ⇒
  // peak-xlen anchor on run→done) is gone. The single anchor created at
  // run start must persist across the running→done transition unchanged
  // so the bar keeps growing smoothly toward 100% rather than jumping.
  it("(E) anchor persists unchanged across the running→done transition", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 1000, rowsPerSec: 1000,
      runId: "01HXRUN", status: "running",
    });
    streamState.xlen = 600;
    streamState.consumed = 0;
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    // Wait for the anchor to be seeded at consumed=0.
    await waitFor(() => {
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
      expect(stored?.consumedAtAnchor).toBe(0);
      expect(stored?.rowsTotal).toBe(1000);
    });
    // Advance to 40% indexed pre-transition.
    streamState.consumed = 400;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const pb = screen.getAllByTestId("indexing-progress")[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("40");
    });
    // Flip run to done; consumer continues draining ⇒ consumed=700.
    // pct = (700 - 0) / 1000 = 70%; anchor is unchanged.
    setMockRun({
      rowsTotal: 1000, rowsDone: 1000, elapsedMs: 2000, rowsPerSec: 500,
      runId: "01HXRUN", status: "done",
    });
    streamState.xlen = 300;
    streamState.consumed = 700;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const pb = screen.getAllByTestId("indexing-progress")[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("70");
    });
    const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
    expect(stored).not.toBeNull();
    expect(stored!.consumedAtAnchor).toBe(0);
    expect(stored!.rowsTotal).toBe(1000);
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix3 — when the consumed counter resets (ingest restart or
  // FLUSHDB on the published key) below the anchor's baseline, the bar
  // must re-anchor at the new value and resume from 0% rather than
  // clamping forever or going negative.
  it("(fix3) re-anchors when consumed drops below the stored baseline (ingest restart)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      consumedAtAnchor: 500,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 200;
    streamState.consumed = 750; // 250 indexed since anchor ⇒ 25%
    vi.stubGlobal("fetch", mockFetch());
    renderPanel();
    await waitFor(() => {
      const bars = screen.queryAllByTestId("indexing-progress");
      expect(bars.length).toBeGreaterThan(0);
      const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
      expect(pb.getAttribute("aria-valuenow")).toBe("25");
    });
    // Ingest restart: published counter resets to 50 (well below the 500
    // baseline). Restart-detection effect re-seeds consumedAtAnchor=50.
    streamState.consumed = 50;
    await vi.advanceTimersByTimeAsync(2_600);
    await waitFor(() => {
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null") as IndexingAnchor | null;
      expect(stored).not.toBeNull();
      expect(stored!.consumedAtAnchor).toBe(50);
    });
    // pct drops to 0% (indexed since new anchor = 0).
    const bars = screen.getAllByTestId("indexing-progress");
    const pb = bars[0]!.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuenow")).toBe("0");
    vi.useRealTimers();
  });

  // Wave 6.41.E.fix3 — tab reload mid-run. The v2 anchor in localStorage
  // is the source of truth across reloads; on remount the bar should
  // resume from the persisted baseline and compute pct off the live
  // consumed counter without re-creating the anchor.
  it("(fix3) tab reload mid-run resumes from persisted v2 anchor without rewriting it", async () => {
    const anchorTs = Date.now() - 5_000;
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 10_000,
      consumedAtAnchor: 1_000,
      anchorTs,
      lastSeenAt: anchorTs,
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    streamState.xlen = 5_000;
    streamState.consumed = 4_000; // 3000 indexed since anchor ⇒ 30%
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
    expect(stored!.consumedAtAnchor).toBe(1_000);
    expect(stored!.rowsTotal).toBe(10_000);
    expect(stored!.anchorTs).toBe(anchorTs);
  });

  // Wave 6.41.E.fix3 — bar shows 0% (not NaN, not hidden) when consumed is
  // exactly at the anchor baseline and rowsTotal > 0 (run just started, no
  // indexing has happened yet).
  it("(E) shows 0% (not NaN, not hidden) when no rows have been consumed since the anchor", async () => {
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 1000,
      consumedAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    setMockRun({
      rowsTotal: 1000, rowsDone: 0, elapsedMs: 0, rowsPerSec: 0,
      runId: "01HXRUN", status: "running",
    });
    streamState.xlen = 1; // > 0 to keep C/D dormant
    streamState.consumed = 0;
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

  // Wave 6.41.E.fix3 — indexing pct grows monotonically as the consumed
  // counter increases against the rowsTotal denominator. Mirrors real
  // production rates: ~30K rows/s drain on a 10M-row target.
  it("(fix3) in-generation pct grows monotonically as consumed advances", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rowsTotal = 10_000_000;
    const drainPerTick = 30_000; // ~30K rows/s × 1 tick
    const anchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal,
      consumedAtAnchor: 0,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    setMockRun({
      rowsTotal, rowsDone: 1_000_000, elapsedMs: 1_000, rowsPerSec: 1_000_000,
      runId: "01HXRUN", status: "running",
    });
    let consumed = drainPerTick;
    streamState.xlen = 1_000_000 - consumed; // positive throughout
    streamState.consumed = consumed;
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
    // Nine more ticks; consumed advances by ~30K each tick.
    for (let i = 0; i < 9; i++) {
      consumed += drainPerTick;
      streamState.consumed = consumed;
      streamState.xlen = Math.max(1, 1_000_000 - consumed);
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
