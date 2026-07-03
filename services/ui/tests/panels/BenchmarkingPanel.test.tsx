import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BenchmarkRunProvider, resetBenchmarkRunForTests } from "../../src/context/BenchmarkRunContext";
import { BenchmarkingPanel } from "../../src/panels/BenchmarkingPanel";
import type { TotalSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

function buildTotalResponse(wallMs: number): TotalSbmResponse {
  return {
    total_sbm: 9558.91,
    winning_scenario: "medium",
    scenario_totals: { low: 9000, medium: 9558, high: 9600 },
    breakdown: [],
    unsupported_classes: [],
    performance: {
      total_ms: wallMs,
      cumulative_ms: wallMs * 10,
      parallelism_factor: 10,
      redis_ops_count: 9,
      ops_skipped: 0,
    },
    resolved_command_summary: "orchestrator",
  };
}

function mockBenchmarkFetch(opts: {
  rows: number;
  wallMsPerRun?: number;
  delayMs?: number;
  /** When set, history returns this run as latest (not max rows). */
  latestRows?: number;
  rollupMissing?: number;
}) {
  let totalCalls = 0;
  const latestRows = opts.latestRows ?? opts.rows;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/ingest/bulk/runs") && !url.includes("/history")) {
      return new Response(JSON.stringify({ active: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/ingest/bulk/runs/history")) {
      return new Response(JSON.stringify({
        runs: [
          {
            run_id: "run-old",
            status: "done",
            rows_total: 400_000_000,
            rows_written: 400_000_000,
            rows_sent: 400_000_000,
            rows_skipped: 0,
            avg_producer_rps: 1,
            avg_write_rps: 1,
            duration_ms: 1,
            started_at_iso: "2026-01-01T00:00:00.000Z",
            ended_at_iso: "2026-01-01T00:01:00.000Z",
            bulk_loader_base: "http://bulk-loader:8086",
            workers: 4,
            batch_size: 500,
            concurrency: 32,
          },
          {
            run_id: "run-new",
            status: "done",
            rows_total: latestRows,
            rows_written: latestRows,
            rows_sent: latestRows,
            rows_skipped: 0,
            avg_producer_rps: 1,
            avg_write_rps: 1,
            duration_ms: 1,
            started_at_iso: "2026-02-01T00:00:00.000Z",
            ended_at_iso: "2026-02-01T00:01:00.000Z",
            bulk_loader_base: "http://bulk-loader:8086",
            workers: 4,
            batch_size: 500,
            concurrency: 32,
          },
        ],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("/admin/calc-coverage")) {
      const missing = opts.rollupMissing ?? 0;
      return new Response(JSON.stringify({
        coverage: [],
        summary: { present: 9 - missing, total: 9, missing },
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("/calc/sbm/total")) {
      totalCalls += 1;
      expect(url).toContain("nocache=1");
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      const wallMs = opts.wallMsPerRun ?? 40_000;
      return new Response(JSON.stringify(buildTotalResponse(wallMs)), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => totalCalls;
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <BenchmarkRunProvider>
        <BenchmarkingPanel />
      </BenchmarkRunProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetBenchmarkRunForTests();
  vi.restoreAllMocks();
});

describe("<BenchmarkingPanel />", () => {
  it("runs one cold total at the snapped tier for a 400M portfolio", async () => {
    const getTotalCalls = mockBenchmarkFetch({ rows: 400_000_000, latestRows: 400_000_000 });

    renderPanel();

    expect(await screen.findByTestId("benchmark-portfolio-rows")).toHaveTextContent("400M");
    expect(screen.getByTestId("benchmark-step-count")).toHaveTextContent("1");
    expect(screen.getByText(/4 ladder rows skipped/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("benchmark-run"));

    await waitFor(() => {
      expect(screen.getByTestId("benchmark-row-400000000")).toHaveAttribute("data-status", "done");
    }, { timeout: 10_000 });

    expect(getTotalCalls()).toBe(1);
    expect(screen.getByTestId("benchmark-wall-400000000")).toHaveTextContent("40.00 s");
    expect(screen.getByTestId("benchmark-row-10000000")).toHaveAttribute("data-status", "skipped");
  });

  it("uses latest ingest not max history (10M after 400M)", async () => {
    const getTotalCalls = mockBenchmarkFetch({ rows: 400_000_000, latestRows: 10_000_000 });

    renderPanel();

    expect(await screen.findByTestId("benchmark-portfolio-rows")).toHaveTextContent("10M");
    expect(screen.getByTestId("benchmark-step-count")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("benchmark-run"));

    await waitFor(() => {
      expect(screen.getByTestId("benchmark-row-10000000")).toHaveAttribute("data-status", "done");
    });

    expect(getTotalCalls()).toBe(1);
  });

  it("shows rollup warning when tuples are missing", async () => {
    mockBenchmarkFetch({ rows: 10_000_000, rollupMissing: 3 });
    renderPanel();

    expect(await screen.findByTestId("benchmark-rollup-warn")).toHaveTextContent(/3 rollup tuple/);
  });

  it("limits display ladder when portfolio is below 400M", async () => {
    mockBenchmarkFetch({ rows: 120_000_000, latestRows: 120_000_000 });
    renderPanel();

    expect(await screen.findByTestId("benchmark-step-count")).toHaveTextContent("1");
    expect(screen.queryByTestId("benchmark-row-400000000")).toBeNull();
    expect(screen.getByTestId("benchmark-row-100000000")).toHaveAttribute("data-runnable", "true");
  });

  it("keeps benchmark progress when navigating away from the panel", async () => {
    mockBenchmarkFetch({ rows: 400_000_000, latestRows: 400_000_000, delayMs: 80 });

    const { rerender } = render(
      <MemoryRouter>
        <BenchmarkRunProvider>
          <BenchmarkingPanel />
        </BenchmarkRunProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("benchmark-portfolio-rows")).toHaveTextContent("400M");
    fireEvent.click(screen.getByTestId("benchmark-run"));

    await waitFor(() => {
      expect(screen.getByTestId("benchmark-row-400000000")).toHaveAttribute("data-status", "running");
    });

    rerender(
      <MemoryRouter>
        <BenchmarkRunProvider>
          <div data-testid="other-route">Other page</div>
        </BenchmarkRunProvider>
      </MemoryRouter>,
    );

    rerender(
      <MemoryRouter>
        <BenchmarkRunProvider>
          <BenchmarkingPanel />
        </BenchmarkRunProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("benchmark-running-banner")).toBeInTheDocument();
    expect(screen.getByTestId("benchmark-row-400000000")).toHaveAttribute("data-status", "running");

    await waitFor(() => {
      expect(screen.getByTestId("benchmark-row-400000000")).toHaveAttribute("data-status", "done");
    }, { timeout: 10_000 });
  });
});
