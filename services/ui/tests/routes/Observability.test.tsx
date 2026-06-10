import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Observability } from "../../src/routes/Observability";

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(handler: (url: string) => Response | Promise<Response>): FetchMock {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as FetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

  it("renders total keys, memory and per-shard breakdown on success", async () => {
    mockFetch((url) => {
      if (url.endsWith("/observability/keys?prefix=sens:")) {
        return jsonResponse({ prefix: "sens:", dbsize: 1234, sample: [], sample_size: 0, ms: 2.5 });
      }
      if (url.endsWith("/observability/memory")) {
        return jsonResponse({ used_memory: 1048576, used_memory_human: "1.00M", ms: 1.2 });
      }
      if (url.endsWith("/observability/shards")) {
        return jsonResponse([
          { shardId: "shard-1", role: "master", opsPerSec: 1200, slotCount: 5461, usedMemoryBytes: 524288, netInBytes: 0, netOutBytes: 0 },
          { shardId: "shard-2", role: "master", opsPerSec: 980, slotCount: 5462, usedMemoryBytes: 524288, netInBytes: 0, netOutBytes: 0 },
        ]);
      }
      if (url.includes("/calc/recent")) return jsonResponse({ items: [] });
      return jsonResponse({}, 404);
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText("1,234")).toBeInTheDocument();
    });
    expect(screen.getByText(/1\.00M/)).toBeInTheDocument();
    expect(screen.getAllByText("shard-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("shard-2").length).toBeGreaterThan(0);
  });

  it("renders an empty state when there are 0 keys and 0 shards", async () => {
    mockFetch((url) => {
      if (url.endsWith("/observability/keys?prefix=sens:")) {
        return jsonResponse({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 0 });
      }
      if (url.endsWith("/observability/memory")) {
        return jsonResponse({ used_memory: 0, used_memory_human: "0B", ms: 0 });
      }
      if (url.endsWith("/observability/shards")) {
        return jsonResponse([]);
      }
      if (url.includes("/calc/recent")) return jsonResponse({ items: [] });
      return jsonResponse({}, 404);
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

  // Wave 5.57 — wiring of /observability/history + popout modal.
  it("renders sparklines and shows the TimeSeries source label in the popout modal", async () => {
    mockFetch((url) => {
      if (url.endsWith("/observability/keys?prefix=sens:")) {
        return jsonResponse({ prefix: "sens:", dbsize: 1234, sample: [], sample_size: 0, ms: 0 });
      }
      if (url.endsWith("/observability/memory")) {
        return jsonResponse({ used_memory: 1, used_memory_human: "1B", ms: 0 });
      }
      if (url.endsWith("/observability/shards")) {
        return jsonResponse([
          { shardId: "shard-1", role: "master", opsPerSec: 100, slotCount: 1, usedMemoryBytes: 1, netInBytes: 0, netOutBytes: 0 },
        ]);
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
      if (url.includes("/calc/recent")) return jsonResponse({ items: [] });
      return jsonResponse({}, 404);
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("1,234")).toBeInTheDocument());
    // 4 tile buttons (the four Cluster snapshot metrics).
    await waitFor(() => expect(screen.getAllByTestId("metric-tile-button").length).toBe(4));
    const [first] = screen.getAllByTestId("metric-tile-button");
    fireEvent.click(first!);
    await waitFor(() => expect(screen.getByTestId("metric-history-modal")).toBeInTheDocument());
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/Redis TimeSeries/);
  });

  it("falls back to ring-buffer source label when /observability/history reports unavailable", async () => {
    mockFetch((url) => {
      if (url.endsWith("/observability/keys?prefix=sens:")) {
        return jsonResponse({ prefix: "sens:", dbsize: 5, sample: [], sample_size: 0, ms: 0 });
      }
      if (url.endsWith("/observability/memory")) {
        return jsonResponse({ used_memory: 1, used_memory_human: "1B", ms: 0 });
      }
      if (url.endsWith("/observability/shards")) {
        return jsonResponse([
          { shardId: "shard-1", role: "master", opsPerSec: 50, slotCount: 1, usedMemoryBytes: 1, netInBytes: 0, netOutBytes: 0 },
        ]);
      }
      if (url.includes("/observability/history")) {
        return jsonResponse({
          source: "unavailable", metric: "total_keys", windowMs: 18_000_000,
          points: [], reason: "module-not-loaded", target_label: "tA",
        });
      }
      if (url.includes("/calc/recent")) return jsonResponse({ items: [] });
      return jsonResponse({}, 404);
    });
    renderRoute();
    await waitFor(() => expect(screen.getAllByTestId("metric-tile-button").length).toBe(4));
    fireEvent.click(screen.getAllByTestId("metric-tile-button")[0]!);
    await waitFor(() => expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/this browser/));
  });

  it("renders the ObservabilityModule enterprise callout banner", async () => {
    mockFetch((url) => {
      if (url.endsWith("/observability/keys?prefix=sens:")) {
        return jsonResponse({ prefix: "sens:", dbsize: 1, sample: ["sens:{GIRR:USD}:abc"], sample_size: 1, ms: 0 });
      }
      if (url.endsWith("/observability/memory")) {
        return jsonResponse({ used_memory: 1, used_memory_human: "1B", ms: 0 });
      }
      if (url.endsWith("/observability/shards")) {
        return jsonResponse([]);
      }
      if (url.includes("/calc/recent")) return jsonResponse({ items: [] });
      return jsonResponse({}, 404);
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText(/ObservabilityModule/)).toBeInTheDocument();
    });
    expect(screen.getByText(/business value/i)).toBeInTheDocument();
  });
});
