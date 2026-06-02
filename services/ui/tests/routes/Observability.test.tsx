import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
      return jsonResponse({}, 404);
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText(/ObservabilityModule/)).toBeInTheDocument();
    });
    expect(screen.getByText(/business value/i)).toBeInTheDocument();
  });
});
