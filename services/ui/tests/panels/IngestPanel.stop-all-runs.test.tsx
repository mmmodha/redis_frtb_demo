// Wave 5.44 / 6.53.A — Stop generators button + /admin/stop-runs wiring in
// IngestPanel. Mirrors the 5.38c flush-db test layout. Wave 6.53.A
// decoupled this from the destructive halt-and-flush: the button now hits
// the non-destructive /admin/stop-runs route and the banner no longer
// surfaces a flush summary. Use "Flush DB" for the destructive path.
//
// Wave 6.53.C — added the snap-to-completion case at the bottom of the
// file: confirming Stop generators while an indexing anchor is active
// rewrites the anchor with rowsTotal = (indexCountNow - indexCountAtAnchor)
// so the bar reaches 100%, the existing "Indexing complete" banner fires,
// and the 3s auto-clear takes over.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import { GeneratorRunProvider } from "../../src/context/GeneratorRunContext";
import { readAnchor, storageKeyFor, type IndexingAnchor } from "../../src/lib/indexingState";

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
function memoryResponse() {
  return { used_memory: 0, used_memory_human: "0B", ms: 1 };
}

interface FetchOpts {
  cancelled?: number;
  run_ids?: string[];
  // Wave 6.53.B — optional trim summary returned by /admin/stop-runs. The
  // api proxies a `{ clearDocs: false }` call to ingest after the cancel
  // drain so the consumer's input backlog is XTRIMmed. `null` simulates
  // ingest being unreachable (banner omits the trim tail).
  trim?: { streams_trimmed: number } | null;
}

function mockFetch(opts: FetchOpts = {}) {
  const {
    cancelled = 2,
    run_ids = ["run-A", "run-B"],
    trim = { streams_trimmed: 4 },
  } = opts;
  const fetchMock = vi.fn();
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse() };
    if (url.endsWith("/admin/stop-runs") && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, cancelled, run_ids, trim }) };
    }
    if (url.endsWith("/generator/runs") && method === "GET") {
      return { ok: true, json: async () => ({ active: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — Stop generators button (Wave 5.44 / 6.53.A)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders a danger-styled 'Stop generators' button alongside Flush DB", async () => {
    fetchMock = mockFetch();
    renderPanel();
    const btn = await screen.findByTestId("stop-all-runs-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/stop generators/i);
    expect(btn.className).toMatch(/btn--danger/);
    // Coexistence with the existing Flush DB button.
    expect(await screen.findByTestId("flush-db-btn")).toBeInTheDocument();
  });

  it("clicking the button opens the confirm modal — no POST yet", async () => {
    fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    const modal = await screen.findByTestId("stop-all-runs-modal");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByRole("heading", { name: /stop active generators/i })).toBeInTheDocument();
    // Wave 6.53.B — modal copy makes it explicit that the in-flight stream
    // backlog is discarded while existing sens data is kept, and points
    // users at "Flush DB" for the destructive wipe path.
    expect(within(modal).getByText(/discards the in-flight stream backlog/i)).toBeInTheDocument();
    expect(within(modal).getByText(/existing sens data in redis is kept/i)).toBeInTheDocument();
    expect(within(modal).getByText(/flush db/i)).toBeInTheDocument();
    const posted = fetchMock.mock.calls.find(
      (c) => /\/admin\/stop-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("clicking Cancel in the modal closes it without POSTing", async () => {
    fetchMock = mockFetch();
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    const modal = await screen.findByTestId("stop-all-runs-modal");
    fireEvent.click(within(modal).getByTestId("stop-all-runs-cancel"));
    await waitFor(() => expect(screen.queryByTestId("stop-all-runs-modal")).not.toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      (c) => /\/admin\/stop-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBeUndefined();
  });

  it("Confirm POSTs /admin/stop-runs and shows a banner with the cancelled count + trim tail (no destructive flush summary)", async () => {
    fetchMock = mockFetch({ cancelled: 2, run_ids: ["run-A", "run-B"], trim: { streams_trimmed: 4 } });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/admin\/stop-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    // Wave 6.53.A — the legacy /admin/cancel-all-runs route stays wired on
    // the api for backward compat but the UI must no longer hit it.
    const legacyPosted = fetchMock.mock.calls.find(
      (c) => /\/admin\/cancel-all-runs$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(legacyPosted).toBeUndefined();
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/stopped 2 generators/i);
    // Wave 6.53.B — banner now appends the non-destructive trim tail so
    // operators see the backlog was discarded. The legacy destructive
    // "flushed"/"indexed rows" copy must still be absent.
    expect(banner).toHaveTextContent(/discarded backlog \(4 streams trimmed\)/i);
    expect(banner.textContent ?? "").not.toMatch(/flushed/i);
    expect(banner.textContent ?? "").not.toMatch(/indexed rows/i);
  });

  it("banner reads 'No active runs' when the server reports cancelled:0 (still surfaces trim tail)", async () => {
    fetchMock = mockFetch({ cancelled: 0, run_ids: [], trim: { streams_trimmed: 1 } });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/no active runs/i);
    // Wave 6.53.B — trim is independent of the cancel count: even with no
    // running producers the consumer-side XTRIM still happens, so the
    // tail renders ("1 stream trimmed", singular pluralisation).
    expect(banner).toHaveTextContent(/discarded backlog \(1 stream trimmed\)/i);
    // No destructive flush summary even on the empty-runs banner.
    expect(banner.textContent ?? "").not.toMatch(/flushed/i);
  });

  // Wave 6.53.B — when ingest is unreachable the api returns trim:null and
  // the UI must gracefully omit the trim tail rather than rendering
  // "null streams trimmed". The cancel-side summary still renders.
  it("omits the trim tail when the server returns trim:null (ingest unreachable)", async () => {
    fetchMock = mockFetch({ cancelled: 1, run_ids: ["run-X"], trim: null });
    renderPanel();
    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    const banner = await screen.findByTestId("stop-all-runs-banner");
    expect(banner).toHaveTextContent(/stopped 1 generator/i);
    expect(banner.textContent ?? "").not.toMatch(/discarded backlog/i);
    expect(banner.textContent ?? "").not.toMatch(/trimmed/i);
  });

  // Wave 6.53.C — confirming Stop generators while an indexing anchor is
  // active snaps the anchor's rowsTotal down to (indexCountNow -
  // indexCountAtAnchor). That makes atTarget flip to true on the very next
  // render, the existing "Indexing complete" banner fires, and the 3s
  // auto-clear takes over — instead of the bar sitting stuck against the
  // original rowsTotal until the 25s plateau backstop kicks in.
  it("snaps the indexing anchor to rowsTotal = indexed when an anchor is active", async () => {
    const TEST_LABEL = "test-label";
    const INDEX_COUNT_NOW = 45_000;
    const baseAnchor: IndexingAnchor = {
      runId: "01HXRUN",
      rowsTotal: 100_000,
      indexCountAtAnchor: 1_000,
      anchorTs: Date.now(),
      lastSeenAt: Date.now(),
      targetLabel: TEST_LABEL,
    };
    localStorage.setItem(storageKeyFor(TEST_LABEL), JSON.stringify(baseAnchor));

    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
      if (url.includes("/observability/keys")) return { ok: true, json: async () => keysResponse(0) };
      if (url.includes("/observability/memory")) return { ok: true, json: async () => memoryResponse() };
      if (url.endsWith("/redis/active-target") && method === "GET") {
        return { ok: true, json: async () => ({ host: "h", port: 6379, tls: false, db: 0, label: TEST_LABEL }) };
      }
      if (url.endsWith("/admin/index-count") && method === "GET") {
        return { ok: true, json: async () => ({ ok: true, count: INDEX_COUNT_NOW, index_name: "idx:sens:v1" }) };
      }
      if (url.endsWith("/admin/stop-runs") && method === "POST") {
        return { ok: true, status: 200, json: async () => ({ ok: true, cancelled: 1, run_ids: ["r1"], trim: { streams_trimmed: 1 } }) };
      }
      if (url.endsWith("/generator/runs") && method === "GET") return { ok: true, json: async () => ({ active: [] }) };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();

    // Wait for the parent's 1s telemetry poll to land so lastIndexCount
    // reflects the mocked /admin/index-count=45000 before the helper runs.
    await waitFor(() => {
      const polled = fetchMock.mock.calls.find(
        (c) => /\/admin\/index-count$/.test(String(c[0])),
      );
      expect(polled).toBeDefined();
    });

    fireEvent.click(await screen.findByTestId("stop-all-runs-btn"));
    fireEvent.click(within(await screen.findByTestId("stop-all-runs-modal")).getByTestId("stop-all-runs-confirm"));
    await screen.findByTestId("stop-all-runs-banner");

    const snapped = readAnchor(TEST_LABEL);
    expect(snapped).not.toBeNull();
    expect(snapped!.rowsTotal).toBe(44_000);
    expect(snapped!.indexCountAtAnchor).toBe(1_000);
    expect(snapped!.runId).toBe("01HXRUN");
    expect(snapped!.targetLabel).toBe(TEST_LABEL);

    // Bonus: the bar reaches 100% and surfaces the "Indexing complete"
    // banner via the existing completion lifecycle.
    await screen.findByTestId("indexing-complete");

    localStorage.removeItem(storageKeyFor(TEST_LABEL));
  });
});
