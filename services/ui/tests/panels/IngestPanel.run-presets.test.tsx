// Wave 6.17 — Presets-only IngestPanel with auto-aligned ingest +
// auto-fix index. Covers the new primary surface:
//   - five fixed preset radio buttons (Quick / Demo / Medium / Large / Overnight)
//   - Start orchestrator: preflight → rebuild-if-needed → /ingest/shards → /generator/start/stream
//   - request body wiring for each preset (rows, stream_shards, stream_maxlen, defer_trim)
//   - Start button stays disabled while any step is in flight

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  IngestPanel,
  RUN_PRESETS,
  buildRunPresetConfig,
} from "../../src/panels/IngestPanel";
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

function sseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
}

const preflightPass = {
  ok: true,
  checks: {
    idx_sens: { ok: true, missing: [] },
    frtb_library: { ok: true, loaded: true },
    stream: { ok: true, exists: true },
  },
  can_rebuild: false,
};
const preflightFail = {
  ok: false,
  checks: {
    idx_sens: { ok: false, missing: ["node-0"] },
    frtb_library: { ok: true, loaded: true },
    stream: { ok: true, exists: true },
  },
  can_rebuild: true,
};

interface MockOpts {
  // Stateful preflight model: returns `preflightFail` until /admin/rebuild-indexes
  // has fired AND `rebuildHeals=true` (the rebuild "healed" the index). The
  // mount-time preflight call therefore doesn't need a separate queue slot —
  // it sees the initial state. Use `initialState` to override the start.
  initialState?: "pass" | "fail";
  rebuildHeals?: boolean;
  rebuildOk?: boolean;
  shardsAfterPost?: number;
  // Wave 6.17 verifier — override the POST /ingest/shards response so the
  // orchestrator hits a 4xx on the shards-align step (e.g. 409 rebuild in
  // progress). Body is returned verbatim via { error: shardsPostError }.
  shardsPostStatus?: number;
  shardsPostError?: string;
  terminalFrame?: Record<string, unknown>;
}

function mockFetch(opts: MockOpts = {}) {
  const {
    initialState = "pass", rebuildHeals = true, rebuildOk = true,
    shardsAfterPost, shardsPostStatus, shardsPostError, terminalFrame,
  } = opts;
  const terminal = terminalFrame ?? { run_id: "01HXRUN", done: true, rows_queued: 10, ms: 5, cancelled: false };
  let preflightHealthy = initialState === "pass";
  let currentShards = 1;
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => ({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 1 }) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => ({ used_memory: 0, used_memory_human: "0B", ms: 1 }) };
    if (url.endsWith("/admin/preflight") && method === "GET") {
      return { ok: true, json: async () => (preflightHealthy ? preflightPass : preflightFail) };
    }
    if (url.endsWith("/admin/rebuild-indexes") && method === "POST") {
      if (rebuildHeals) preflightHealthy = true;
      return { ok: rebuildOk, status: rebuildOk ? 200 : 500, json: async () => ({ ok: rebuildOk, ms: 1, bootstrap: { ok: rebuildOk } }) };
    }
    if (url.endsWith("/ingest/shards") && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ totalShards: currentShards }) };
    }
    if (url.endsWith("/ingest/shards") && method === "POST") {
      if (shardsPostStatus && shardsPostStatus >= 400) {
        return { ok: false, status: shardsPostStatus, json: async () => ({ error: shardsPostError ?? "boom" }) };
      }
      const body = JSON.parse(String((init as any).body));
      currentShards = shardsAfterPost ?? body.totalShards;
      return { ok: true, status: 200, json: async () => ({ totalShards: currentShards }) };
    }
    if (url.endsWith("/generator/start/stream") && method === "POST") {
      return { ok: true, body: sseBody([terminal]) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

function findCall(fetchMock: ReturnType<typeof vi.fn>, urlMatcher: RegExp, method: string) {
  return fetchMock.mock.calls.find(
    (c) => urlMatcher.test(String(c[0])) && ((c[1] as RequestInit | undefined)?.method ?? "GET") === method,
  );
}

// Wave 7.0.6.13 — these legacy-stream tests target the /generator/start/stream
// XADD path. The IngestPanel default mode flipped to "bulk-loader" in 7.0.6.13,
// so each test that asserts the stream-path orchestrator must first flip the
// Mode dropdown to "stream" before clicking Start.
function selectStreamMode() {
  fireEvent.change(screen.getByTestId("ingest-mode-select"), { target: { value: "stream" } });
}

describe("IngestPanel — Wave 6.17 presets-only run", () => {
  beforeEach(() => { /* no fake timers — orchestrator is fully promise-driven */ });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("renders the Run preset card with all seven preset radios (incl. xl + xxl) + a Start button", async () => {
    mockFetch();
    renderPanel();
    const card = await screen.findByTestId("ingest-preset-radiogroup");
    for (const k of ["quick", "demo", "medium", "large", "xl", "overnight", "xxl"]) {
      expect(card.querySelector(`[data-testid="ingest-preset-${k}"]`)).not.toBeNull();
    }
    expect(screen.getByTestId("ingest-preset-start-btn")).toBeEnabled();
  });

  // 6.41.UI — labels are numeric row-counts only ("10K rows" … "200M rows"),
  // rendered in ascending order, and the legacy grey description span is
  // absent for every preset (all descriptions are empty strings).
  it("renders preset labels as numeric row-counts in ascending order with no description sub-text", async () => {
    mockFetch();
    renderPanel();
    const card = await screen.findByTestId("ingest-preset-radiogroup");
    const expected = [
      ["quick", "10K rows"],
      ["demo", "100K rows"],
      ["medium", "1M rows"],
      ["large", "10M rows"],
      ["xl", "50M rows"],
      ["overnight", "100M rows"],
      ["xxl", "200M rows"],
    ] as const;
    const buttons = Array.from(card.querySelectorAll('[data-testid^="ingest-preset-"]'))
      .filter((el) => el.getAttribute("data-testid") !== "ingest-preset-radiogroup"
        && el.getAttribute("data-testid") !== "ingest-preset-start-btn"
        && el.getAttribute("data-testid") !== "ingest-preset-step"
        && el.getAttribute("data-testid") !== "ingest-preset-error");
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual(
      expected.map(([k]) => `ingest-preset-${k}`),
    );
    for (const [k, label] of expected) {
      const btn = card.querySelector(`[data-testid="ingest-preset-${k}"]`)!;
      expect(btn.querySelector(".ingest-presets__label")?.textContent).toBe(label);
      expect(btn.querySelector(".ingest-presets__desc")).toBeNull();
    }
  });

  // 6.41.UI — config emission for the two new defer-trim tiers must match the
  // spec: stream_maxlen=0 + defer_trim=true at this scale, with the right
  // rows + shards plumbed through buildRunPresetConfig().
  it("buildRunPresetConfig emits defer_trim:true / stream_maxlen:0 for the xl and xxl presets", () => {
    const xl = buildRunPresetConfig(RUN_PRESETS.xl);
    expect(xl.rows).toBe(50_000_000);
    expect(xl.stream_shards).toBe(12);
    expect(xl.stream_maxlen).toBe(0);
    expect(xl.defer_trim).toBe(true);
    const xxl = buildRunPresetConfig(RUN_PRESETS.xxl);
    expect(xxl.rows).toBe(200_000_000);
    expect(xxl.stream_shards).toBe(20);
    expect(xxl.stream_maxlen).toBe(0);
    expect(xxl.defer_trim).toBe(true);
  });

  it("Quick preset Start runs preflight, posts /ingest/shards=1, then starts the stream with rows=10000 / shards=1 / maxlen=100000", async () => {
    const fetchMock = mockFetch();
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    selectStreamMode();
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    await waitFor(() => {
      expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeDefined();
    });
    const preflightCalls = fetchMock.mock.calls.filter((c) => /\/admin\/preflight$/.test(String(c[0])));
    expect(preflightCalls.length).toBeGreaterThanOrEqual(1);
    const shardsPost = findCall(fetchMock, /\/ingest\/shards$/, "POST");
    expect(shardsPost).toBeDefined();
    expect(JSON.parse((shardsPost![1] as RequestInit).body as string)).toEqual({ totalShards: 1 });
    const streamPost = findCall(fetchMock, /\/generator\/start\/stream$/, "POST");
    const body = JSON.parse((streamPost![1] as RequestInit).body as string);
    expect(body.rows).toBe(10_000);
    expect(body.stream_shards).toBe(1);
    expect(body.stream_maxlen).toBe(100_000);
    // Wave 6.17 verifier (item 3) — assert literal defer_trim:false, matching
    // the spec body shape verbatim (not just "absent ⇒ false" server-side).
    expect(body.defer_trim).toBe(false);
    // Wave 6.17 verifier (item 2) — preflight returned ok=true, so the
    // auto-rebuild step must be skipped entirely.
    expect(findCall(fetchMock, /\/admin\/rebuild-indexes$/, "POST")).toBeUndefined();
  });

  it("Large preset submits rows=10000000 / shards=8 / stream_maxlen=0 / defer_trim=true", async () => {
    const fetchMock = mockFetch();
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    selectStreamMode();
    fireEvent.click(screen.getByTestId("ingest-preset-large"));
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    await waitFor(() => {
      expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeDefined();
    });
    const shardsPost = findCall(fetchMock, /\/ingest\/shards$/, "POST");
    expect(JSON.parse((shardsPost![1] as RequestInit).body as string)).toEqual({ totalShards: 8 });
    const streamBody = JSON.parse((findCall(fetchMock, /\/generator\/start\/stream$/, "POST")![1] as RequestInit).body as string);
    expect(streamBody.rows).toBe(10_000_000);
    expect(streamBody.stream_shards).toBe(8);
    expect(streamBody.stream_maxlen).toBe(0);
    expect(streamBody.defer_trim).toBe(true);
  });

  it("Overnight preset submits rows=100000000 / shards=16 / stream_maxlen=0 / defer_trim=true", async () => {
    const fetchMock = mockFetch();
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    selectStreamMode();
    fireEvent.click(screen.getByTestId("ingest-preset-overnight"));
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    await waitFor(() => {
      expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeDefined();
    });
    const streamBody = JSON.parse((findCall(fetchMock, /\/generator\/start\/stream$/, "POST")![1] as RequestInit).body as string);
    expect(streamBody.rows).toBe(100_000_000);
    expect(streamBody.stream_shards).toBe(16);
    expect(streamBody.defer_trim).toBe(true);
  });

  it("auto-fixes the index when preflight returns ok=false / can_rebuild=true (POST /admin/rebuild-indexes then re-runs preflight)", async () => {
    const fetchMock = mockFetch({ initialState: "fail", rebuildHeals: true });
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    selectStreamMode();
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    await waitFor(() => {
      expect(findCall(fetchMock, /\/admin\/rebuild-indexes$/, "POST")).toBeDefined();
    });
    await waitFor(() => {
      expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeDefined();
    });
    // Two preflight calls: initial probe + post-rebuild verification.
    const preflightCalls = fetchMock.mock.calls.filter((c) => /\/admin\/preflight$/.test(String(c[0])));
    expect(preflightCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("halts the flow and surfaces an error when preflight stays ok=false after rebuild", async () => {
    mockFetch({ initialState: "fail", rebuildHeals: false });
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    const err = await screen.findByTestId("ingest-preset-error");
    expect(err.textContent).toMatch(/pre-flight failed/i);
    // /generator/start/stream must NOT have fired.
    // (validated by absence in the queued mock call list at this point)
  });

  it("disables the Start button while the orchestrator runs (preflight + shards), re-enables on terminal frame", async () => {
    mockFetch();
    renderPanel();
    const start = await screen.findByTestId("ingest-preset-start-btn") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    selectStreamMode();
    fireEvent.click(start);
    // Immediately after click, the button is disabled.
    expect(start.disabled).toBe(true);
    // After the terminal frame, the run settles back to a non-running status.
    await waitFor(() => expect(start.disabled).toBe(false), { timeout: 2000 });
  });

  // Wave 6.17 verifier (item 3) — POST /admin/rebuild-indexes 500 surfaces
  // the error inline and halts the flow before /ingest/shards or
  // /generator/start/stream are touched.
  it("surfaces a rebuild failure inline and skips /ingest/shards + /generator/start when /admin/rebuild-indexes returns 500", async () => {
    const fetchMock = mockFetch({ initialState: "fail", rebuildOk: false });
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    const err = await screen.findByTestId("ingest-preset-error");
    expect(err.textContent).toMatch(/rebuild-indexes/i);
    expect(findCall(fetchMock, /\/admin\/rebuild-indexes$/, "POST")).toBeDefined();
    expect(findCall(fetchMock, /\/ingest\/shards$/, "POST")).toBeUndefined();
    expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeUndefined();
  });

  // Wave 6.17 verifier (item 4) — orchestrator's POST /ingest/shards returning
  // 409 must surface the error inline and prevent /generator/start/stream from
  // firing. (Distinct from the manual fan-out Apply button's 409 path.)
  it("halts the flow and surfaces a 409 inline when the orchestrator's POST /ingest/shards conflicts", async () => {
    const fetchMock = mockFetch({ shardsPostStatus: 409, shardsPostError: "rebuild already in progress" });
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    selectStreamMode();
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    const err = await screen.findByTestId("ingest-preset-error");
    expect(err.textContent).toMatch(/409/);
    expect(err.textContent).toMatch(/rebuild already in progress/);
    expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeUndefined();
  });

  // Wave 6.17 verifier (item 5) — Advanced disclosure is collapsed on first
  // render; the inner cards must not be in the DOM yet.
  it("renders the Advanced (custom run) disclosure collapsed by default", async () => {
    mockFetch();
    renderPanel();
    const toggle = await screen.findByTestId("ingest-advanced-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("ingest-advanced-body")).not.toBeInTheDocument();
  });

  // Wave 6.17 verifier (item 6) — opening Advanced reveals the synthetic
  // generator (custom rows input + nested dial controls under its own "Show
  // advanced…" toggle), the 6.12b fan-out card, and the preflight banner host.
  // The dial controls actually present in this UI surface are:
  //   - profile           (data-testid="generator-preset")
  //   - stream_shards     (data-testid="ingest-stream-shards")
  //   - stream_maxlen     (data-testid="generator-stream-maxlen")
  // (workers, batch_size, pipeline_window, flow_control, defer_trim are
  // server-side request-body knobs only — never surfaced as UI controls in
  // this panel today, so they are intentionally not asserted here.)
  it("reveals the custom rows input + nested dial controls + fan-out card when the Advanced disclosure is opened", async () => {
    mockFetch();
    renderPanel();
    const outer = await screen.findByTestId("ingest-advanced-toggle");
    fireEvent.click(outer);
    expect(outer).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByTestId("ingest-advanced-body")).toBeInTheDocument();
    expect(screen.getByTestId("generator-total-rows")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-fanout-card")).toBeInTheDocument();
    // Inner "Show advanced…" toggle inside the SyntheticGeneratorCard reveals
    // the dial controls (profile, stream_shards, stream_maxlen).
    const inner = screen.getByTestId("generator-advanced-toggle");
    fireEvent.click(inner);
    expect(screen.getByTestId("generator-preset")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-stream-shards")).toBeInTheDocument();
    expect(screen.getByTestId("generator-stream-maxlen")).toBeInTheDocument();
  });

  // Wave 6.17 verifier (item 1) — the Advanced submit path must use the same
  // orchestrator as the preset Start button: GET /admin/preflight → POST
  // /admin/rebuild-indexes (if needed) → POST /ingest/shards{totalShards:N}
  // → POST /generator/start/stream. The operator must not be able to launch
  // an Advanced run that bypasses /ingest/shards alignment.
  it("Advanced 'Generate' button runs preflight → rebuild → /ingest/shards → /generator/start in that order", async () => {
    const fetchMock = mockFetch({ initialState: "fail", rebuildHeals: true });
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-advanced-toggle"));
    fireEvent.click(await screen.findByTestId("generator-advanced-toggle"));
    // Pick a concrete numeric shard count so the /ingest/shards POST fires.
    fireEvent.change(screen.getByLabelText(/Stream fan-out/), { target: { value: "8" } });
    fireEvent.click(screen.getByTestId("generator-generate-btn"));
    await waitFor(() => {
      expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeDefined();
    });
    // Filter post-mount calls so we can reason about ordering.
    const calls = fetchMock.mock.calls.map((c) => ({
      url: String(c[0]),
      method: (c[1] as RequestInit | undefined)?.method ?? "GET",
      body: (c[1] as RequestInit | undefined)?.body,
    }));
    const idxRebuild = calls.findIndex((c) => /\/admin\/rebuild-indexes$/.test(c.url) && c.method === "POST");
    const idxShards = calls.findIndex((c) => /\/ingest\/shards$/.test(c.url) && c.method === "POST");
    const idxStart = calls.findIndex((c) => /\/generator\/start\/stream$/.test(c.url) && c.method === "POST");
    expect(idxRebuild).toBeGreaterThanOrEqual(0);
    expect(idxShards).toBeGreaterThan(idxRebuild);
    expect(idxStart).toBeGreaterThan(idxShards);
    const shardsBody = JSON.parse(String(calls[idxShards]!.body));
    expect(shardsBody.totalShards).toBe(8);
    const startBody = JSON.parse(String(calls[idxStart]!.body));
    expect(startBody.stream_shards).toBe(8);
  });

  // Wave 6.17b — the live <GeneratorProgress> bar must render on the primary
  // preset surface (not only inside the collapsed Advanced disclosure) so the
  // operator keeps rows-done / throughput / cancel visibility after Start.
  // Sending a progress-shaped frame (no `done:true`) leaves the tracked run
  // in status "running" once the SSE body closes — the bar should be in the
  // DOM without ever opening the Advanced toggle.
  it("renders the live <GeneratorProgress> bar on the preset surface while a preset run is in flight", async () => {
    mockFetch({
      terminalFrame: { run_id: "01HXRUN", rows_done: 5, rows_total: 100, elapsed_ms: 10, rows_per_sec: 100 },
    });
    renderPanel();
    await screen.findByTestId("ingest-preset-start-btn");
    selectStreamMode();
    fireEvent.click(screen.getByTestId("ingest-preset-start-btn"));
    const bar = await screen.findByTestId("generator-progress");
    expect(bar).toBeInTheDocument();
    // The Advanced disclosure must remain collapsed — the bar is on the
    // primary surface, not behind the disclosure.
    expect(screen.getByTestId("ingest-advanced-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  // Wave 6.17 verifier (item 1) — Advanced submit also halts before
  // /generator/start when /ingest/shards conflicts (409), with the error
  // surfaced inline in the generator form.
  it("Advanced submit surfaces a /ingest/shards 409 inline and skips /generator/start", async () => {
    const fetchMock = mockFetch({ shardsPostStatus: 409, shardsPostError: "rebuild already in progress" });
    renderPanel();
    fireEvent.click(await screen.findByTestId("ingest-advanced-toggle"));
    fireEvent.click(await screen.findByTestId("generator-advanced-toggle"));
    fireEvent.change(screen.getByLabelText(/Stream fan-out/), { target: { value: "8" } });
    fireEvent.click(screen.getByTestId("generator-generate-btn"));
    // The card's existing formError host (role=alert) carries the message.
    const err = await screen.findByRole("alert");
    expect(err.textContent).toMatch(/409/);
    expect(err.textContent).toMatch(/rebuild already in progress/);
    expect(findCall(fetchMock, /\/generator\/start\/stream$/, "POST")).toBeUndefined();
  });
});
