// Wave 7.0.4.B — component tests for <PerShardPanel />. The deviation
// computation is unit-tested in tests/lib/per-shard-deviation.test.ts; here
// we cover the render-side contract: the panel attaches a deviation marker
// to flagged rows when imbalance is present and removes it when shards
// rebalance.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { PerShardPanel } from "../../src/components/PerShardPanel";
import type { PerShardRow } from "../../src/lib/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function row(id: string, write_ops_per_sec: number, overrides: Partial<PerShardRow> = {}): PerShardRow {
  return {
    shard_id: id,
    role: "master",
    memory_used: 100,
    key_count: 1000,
    write_ops_per_sec,
    index_lag: 0,
    last_observed_at: null,
    snapshot_age_seconds: null,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.useRealTimers();
});

function mockFetchOnce(body: unknown): void {
  globalThis.fetch = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
}

describe("<PerShardPanel />", () => {
  it("renders one row per shard from the live endpoint", async () => {
    mockFetchOnce([
      row("redis:1", 1000),
      row("redis:2", 1000),
    ]);
    render(<PerShardPanel pollIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("per-shard-row")).toHaveLength(2);
    });
    expect(screen.getByText("redis:1")).toBeInTheDocument();
    expect(screen.getByText("redis:2")).toBeInTheDocument();
  });

  it("does NOT flag any shard when write rps is balanced across the cluster", async () => {
    // mean=1000, every shard within 10% → no deviation flags.
    render(
      <PerShardPanel
        pollIntervalMs={60_000}
        initialRows={[row("redis:1", 1000), row("redis:2", 1000), row("redis:3", 1000)]}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("per-shard-row")).toHaveLength(3);
    });
    const flagged = screen.queryAllByTestId("per-shard-row").filter(
      (el) => el.getAttribute("data-deviation") === "1",
    );
    expect(flagged).toHaveLength(0);
  });

  it("flags the outlier when one shard's write rps deviates >10% from the mean", async () => {
    // Three shards at 1000 and one at 5000 → mean=2000, the 5000-shard is
    // 150% above the mean (and the 1000-shards 50% below) → all flagged.
    render(
      <PerShardPanel
        pollIntervalMs={60_000}
        initialRows={[
          row("redis:1", 1000),
          row("redis:2", 1000),
          row("redis:3", 1000),
          row("redis:4", 5000),
        ]}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("per-shard-row")).toHaveLength(4);
    });
    const flagged = screen.queryAllByTestId("per-shard-row").filter(
      (el) => el.getAttribute("data-deviation") === "1",
    );
    expect(flagged.length).toBeGreaterThan(0);
    // The 5000-shard must be among the flagged set.
    const skewRow = flagged.find((el) => el.getAttribute("data-shard-id") === "redis:4");
    expect(skewRow).toBeDefined();
  });

  it("recomputes deviation flags when the user switches the highlight metric", async () => {
    render(
      <PerShardPanel
        pollIntervalMs={60_000}
        // Balanced on write rps, skewed on memory_used → switching metric
        // should toggle the flag.
        initialRows={[
          row("redis:1", 1000, { memory_used: 100 }),
          row("redis:2", 1000, { memory_used: 100 }),
          row("redis:3", 1000, { memory_used: 5_000 }),
        ]}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("per-shard-row")).toHaveLength(3);
    });
    // On write_ops_per_sec → all balanced.
    let flagged = screen.queryAllByTestId("per-shard-row").filter(
      (el) => el.getAttribute("data-deviation") === "1",
    );
    expect(flagged).toHaveLength(0);
    // Switch to memory_used → the skewed shard must light up.
    act(() => {
      fireEvent.change(screen.getByTestId("per-shard-deviation-metric"), {
        target: { value: "memory_used" },
      });
    });
    flagged = screen.queryAllByTestId("per-shard-row").filter(
      (el) => el.getAttribute("data-deviation") === "1",
    );
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.some((el) => el.getAttribute("data-shard-id") === "redis:3")).toBe(true);
  });

  it("sorts rows by the clicked column", async () => {
    render(
      <PerShardPanel
        pollIntervalMs={60_000}
        initialRows={[row("redis:1", 1000), row("redis:2", 3000), row("redis:3", 2000)]}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("per-shard-row")).toHaveLength(3);
    });
    act(() => {
      fireEvent.click(screen.getByTestId("per-shard-sort-write_ops_per_sec"));
    });
    const ids = screen.getAllByTestId("per-shard-row").map((el) => el.getAttribute("data-shard-id"));
    expect(ids).toEqual(["redis:1", "redis:3", "redis:2"]);
    // Click again → descending.
    act(() => {
      fireEvent.click(screen.getByTestId("per-shard-sort-write_ops_per_sec"));
    });
    const ids2 = screen.getAllByTestId("per-shard-row").map((el) => el.getAttribute("data-shard-id"));
    expect(ids2).toEqual(["redis:2", "redis:3", "redis:1"]);
  });
});
