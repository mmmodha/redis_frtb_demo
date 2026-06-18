// Wave 6.39.D — DriftStatusCard surfaces GET /admin/drift-status as a
// timeline of recent drift checks, with a threshold header pill and a
// drift/ok badge per row. Polls every 10s.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { DriftStatusCard } from "../../src/components/DriftStatusCard";
import type { DriftStatusResponse } from "../../src/lib/admin";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeFetchQueue(bodies: Array<DriftStatusResponse>) {
  let i = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input.toString());
    const body = bodies[Math.min(i++, bodies.length - 1)]!;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

describe("<DriftStatusCard />", () => {
  it("renders threshold pill and rows", async () => {
    makeFetchQueue([{
      threshold_pct: 0.01,
      results: [
        { ts: "2026-06-18T00:00:00Z", bucket: "1", risk_class: "GIRR", sensitivity_type: "Delta", rollup_sum: 100, recomputed_sum: 100, drift_pct: 0, status: "ok" },
        { ts: "2026-06-18T01:00:00Z", bucket: "2", risk_class: "Equity", sensitivity_type: "Vega", rollup_sum: 100, recomputed_sum: 105, drift_pct: 0.05, status: "drift" },
      ],
    }]);
    render(<DriftStatusCard />);
    const table = await screen.findByTestId("drift-status-table");
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBe(3);
    expect(screen.getByTestId("drift-threshold")).toHaveTextContent(/1(\.0)?%/);
    expect(within(table).getAllByText(/drift/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders empty state when no checks have run yet", async () => {
    makeFetchQueue([{ threshold_pct: 0.01, results: [] }]);
    render(<DriftStatusCard />);
    const empty = await screen.findByTestId("drift-status-empty");
    expect(empty).toHaveTextContent(/no drift checks yet/i);
  });

  it("polls /admin/drift-status every 10s", async () => {
    const { calls } = makeFetchQueue([
      { threshold_pct: 0.01, results: [] },
      { threshold_pct: 0.01, results: [] },
      { threshold_pct: 0.01, results: [] },
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DriftStatusCard />);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    const initial = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(calls.length).toBeGreaterThan(initial));
    expect(calls[0]).toMatch(/\/admin\/drift-status$/);
  });
});
