import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Observability } from "../../src/routes/Observability";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function debugPayload(overrides: {
  dbsize?: number;
  used_memory?: number;
  used_memory_human?: string;
  ops?: number;
  index_count?: number;
  calc_items?: unknown[];
} = {}) {
  const dbsize = overrides.dbsize ?? 1234;
  return {
    keys: { prefix: "sens:", dbsize, sample: ["sens:{GIRR:USD}:abc"], sample_size: 1, ms: 0 },
    memory: {
      used_memory: overrides.used_memory ?? 1048576,
      used_memory_human: overrides.used_memory_human ?? "1.00M",
      maxmemory_bytes: 0,
      total_system_memory_bytes: 0,
      instantaneous_ops_per_sec: overrides.ops ?? 2180,
      ms: 0,
    },
    index_count: { count: overrides.index_count ?? dbsize, refreshing: false, index_name: "idx:sens" },
    calc_recent: { items: overrides.calc_items ?? [] },
    bootstrap: { phase: "ready", target_label: "local", err: null },
  };
}

function mockObservabilityFetch(handler?: (url: string) => Response | Promise<Response> | null): FetchMock {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const custom = handler?.(url);
    if (custom) return custom;
    if (url.includes("/observability/debug")) {
      return jsonResponse(debugPayload());
    }
    if (url.includes("/observability/history")) {
      return jsonResponse({
        source: "redis-timeseries",
        metric: "total_keys",
        windowMs: 18_000_000,
        points: [{ t: Date.now() - 60_000, v: 100 }, { t: Date.now(), v: 200 }],
        reason: null,
        target_label: "tA",
      });
    }
    if (url.includes("/ingest/snapshot")) {
      return jsonResponse({
        ok: true,
        target_label: "local",
        cluster: { sens_count: 100, sens_count_refreshing: false, memory_bytes: 1, memory_human: "1B" },
        loader: { in_flight: 0, flush_rps: 0, flushed_total: 0, throttled: false, recent_429_count: 0 },
        runs: [],
        focused_run_id: null,
      });
    }
    if (url.includes("/admin/stream-status")) {
      return jsonResponse({ xlen: 0, maxlen: 10000, peak_rate_per_sec: 0, consumed: 0 });
    }
    if (url.includes("/admin/drift-status")) {
      return jsonResponse({ threshold_pct: 0.01, results: [] });
    }
    if (url.includes("/generator/runs")) return jsonResponse({ active: [] });
    if (url.includes("/ingest/bulk/runs")) return jsonResponse({ active: [] });
    if (url.includes("/ingest/bulk/load-status")) return jsonResponse({ workers: [], dispatcher: { in_flight: 0 } });
    if (url.includes("/ingest/run-history")) return jsonResponse({ runs: [] });
    if (url.includes("/admin/calc-jobs")) return jsonResponse({ active: [] });
    if (url.includes("/admin/recent-errors")) return jsonResponse({ items: [] });
    return jsonResponse({}, 404);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as FetchMock;
}

describe("<Observability />", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.useRealTimers();
  });

  function renderRoute() {
    return render(
      <MemoryRouter initialEntries={["/observability"]}>
        <Observability />
      </MemoryRouter>,
    );
  }

  it("shows a loading state while fetching", () => {
    mockFetch(() => new Promise(() => undefined));
    renderRoute();
    expect(screen.getByText(/loading observability/i)).toBeInTheDocument();
  });

  it("renders cluster snapshot tiles on success", async () => {
    mockObservabilityFetch((url) => {
      if (url.includes("/observability/debug")) {
        return jsonResponse(debugPayload({ index_count: 900 }));
      }
      return null;
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("obs-sens-tile")).toHaveTextContent("900");
    });
    expect(screen.getByText(/1\.00M/)).toBeInTheDocument();
    expect(screen.getByText("2,180")).toBeInTheDocument();
    expect(screen.queryByText("shard-1")).not.toBeInTheDocument();
  });

  it("opens keys sample modal when Total keys tile is clicked", async () => {
    mockObservabilityFetch((url) => {
      if (url.includes("/observability/debug")) {
        return jsonResponse(debugPayload({ index_count: 900 }));
      }
      return null;
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("obs-sens-tile")).toHaveTextContent("900"));
    const keysTile = screen.getAllByTestId("metric-tile-button").find((el) =>
      el.textContent?.includes("Total keys"),
    );
    fireEvent.click(keysTile!);
    await waitFor(() => expect(screen.getByTestId("keys-sample-modal")).toBeInTheDocument());
    expect(screen.getByText("sens:{GIRR:USD}:abc")).toBeInTheDocument();
  });

  it("renders an empty state when there are 0 keys and 0 sensitivities", async () => {
    mockObservabilityFetch((url) => {
      if (url.includes("/observability/debug")) {
        return jsonResponse(debugPayload({ dbsize: 0, index_count: 0, used_memory: 0, used_memory_human: "0B", ops: 0 }));
      }
      return null;
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText(/no sensitivities loaded yet/i)).toBeInTheDocument();
    });
  });

  it("renders an error state when the api call fails", async () => {
    mockFetch(() => Promise.reject(new Error("connection refused")));
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText(/failed to load observability/i)).toBeInTheDocument();
    });
  });

  it("shows workload cards when Redis is busy with an in-flight calc", async () => {
    mockObservabilityFetch((url) => {
      if (url.includes("/observability/debug")) {
        return jsonResponse({ error: "Redis is busy with calculation" }, 503);
      }
      return null;
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("obs-degraded-banner")).toBeInTheDocument();
    }, { timeout: 5_000 });
    expect(screen.getByRole("heading", { name: /active workloads/i, level: 2 })).toBeInTheDocument();
    expect(screen.queryByText(/loading observability/i)).not.toBeInTheDocument();
  });

  it("renders sparklines and shows the TimeSeries source label in the popout modal", async () => {
    mockObservabilityFetch((url) => {
      if (url.includes("/observability/debug")) {
        return jsonResponse(debugPayload({ index_count: 900 }));
      }
      return null;
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("obs-sens-tile")).toHaveTextContent("900"));
    await waitFor(() => expect(screen.getAllByTestId("metric-tile-button").length).toBeGreaterThanOrEqual(3));
    const memoryTile = screen.getAllByTestId("metric-tile-button").find((el) =>
      el.textContent?.includes("Memory used"),
    );
    fireEvent.click(memoryTile!);
    await waitFor(() => expect(screen.getByTestId("metric-history-modal")).toBeInTheDocument());
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/Redis TimeSeries/);
  });

  it("falls back to ring-buffer source label when /observability/history reports unavailable", async () => {
    mockObservabilityFetch((url) => {
      if (url.includes("/observability/history")) {
        return jsonResponse({
          source: "unavailable", metric: "total_keys", windowMs: 18_000_000,
          points: [], reason: "module-not-loaded", target_label: "tA",
        });
      }
      return null;
    });
    renderRoute();
    await waitFor(() => expect(screen.getAllByTestId("metric-tile-button").length).toBeGreaterThanOrEqual(3));
    const memoryTile = screen.getAllByTestId("metric-tile-button").find((el) =>
      el.textContent?.includes("Memory used"),
    );
    fireEvent.click(memoryTile!);
    await waitFor(() => expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/this browser/));
  });

  it("renders the ObservabilityModule enterprise callout banner", async () => {
    mockObservabilityFetch();
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText(/ObservabilityModule/)).toBeInTheDocument();
    });
    expect(screen.getByText(/business value/i)).toBeInTheDocument();
  });

  it("mounts active jobs and ingest snapshot cards", async () => {
    mockObservabilityFetch();
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("active-jobs-card")).toBeInTheDocument());
    expect(screen.getByTestId("ingest-snapshot-card")).toBeInTheDocument();
    expect(screen.getByText(/Active workloads/i)).toBeInTheDocument();
  });
});

function mockFetch(handler: (url: string) => Response | Promise<Response>): FetchMock {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as FetchMock;
}
