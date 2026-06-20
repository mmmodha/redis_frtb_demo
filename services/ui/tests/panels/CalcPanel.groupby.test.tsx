import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import type { CalcSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const calcResponse: CalcSbmResponse = {
  charge: 1036.94,
  per_bucket: [{ bucket: "USD", K_b: 200, S_b: 180, count: 5000, ms: 12 }],
  total_ms: 1500.4,
  shard_breakdown: [{ shard: "shard-1", buckets: ["USD"], ms: 0 }],
  fanout_ms: 14.6,
};

interface PivotRowFixture {
  key: string;
  doc: Record<string, unknown>;
}

function fetchRouter(rows: PivotRowFixture[], calcOverride?: Partial<CalcSbmResponse>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/calc/sbm")) {
      return new Response(JSON.stringify({ ...calcResponse, ...calcOverride }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/pivot")) {
      return new Response(JSON.stringify({ rows, total: rows.length, limit: 20, offset: 0, ms: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function openUsdDrilldown() {
  fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
  await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
  fireEvent.click(
    within(screen.getByTestId("bucket-chart"))
      .getAllByTestId("bucket-chart-row")
      .find((r) => r.getAttribute("data-bucket") === "USD")!,
  );
  await waitFor(() => expect(screen.getByTestId("bucket-drilldown-groupby-select")).toBeInTheDocument());
}

describe("Wave 6.48.B — BucketDrilldown group-by control", () => {
  it("defaults to None and leaves the per-row table unchanged", async () => {
    fetchRouter([
      { key: "k1", doc: { trade_id: "t-1", risk_factor: "USD-IRS-3M", risk_value: 0.1, weight: 1.0, book: "DESK_A" } },
      { key: "k2", doc: { trade_id: "t-2", risk_factor: "USD-IRS-1Y", risk_value: 0.2, weight: 1.0, book: "DESK_B" } },
    ]);
    render(<CalcPanel />);
    await openUsdDrilldown();
    const sel = screen.getByTestId("bucket-drilldown-groupby-select") as HTMLSelectElement;
    expect(sel.value).toBe("none");
    expect(screen.getAllByTestId("drilldown-row").length).toBe(2);
    expect(screen.queryByTestId("drilldown-group-row")).toBeNull();
  });

  it("group-by risk_factor collapses rows into one group per distinct value, sorted desc by Σ exposure", async () => {
    fetchRouter([
      { key: "k1", doc: { trade_id: "t-1", risk_factor: "USD-IRS-3M", risk_value: 0.1, weight: 1.0 } },
      { key: "k2", doc: { trade_id: "t-2", risk_factor: "USD-IRS-3M", risk_value: 0.4, weight: 1.0 } },
      { key: "k3", doc: { trade_id: "t-3", risk_factor: "USD-IRS-1Y", risk_value: 2.0, weight: 1.0 } },
    ]);
    render(<CalcPanel />);
    await openUsdDrilldown();
    fireEvent.change(screen.getByTestId("bucket-drilldown-groupby-select"), { target: { value: "risk_factor" } });
    const groups = screen.getAllByTestId("drilldown-group-row");
    expect(groups.length).toBe(2);
    // Sorted desc by exposure: 1Y (2.0) before 3M (0.5).
    expect(groups[0]!.getAttribute("data-group-key")).toBe("USD-IRS-1Y");
    expect(groups[1]!.getAttribute("data-group-key")).toBe("USD-IRS-3M");
    expect(within(groups[1]!).getByTestId("drilldown-group-count").textContent).toBe("2");
  });

  it("disables a group-by option when the dimension is missing on every fetched row", async () => {
    fetchRouter([
      { key: "k1", doc: { trade_id: "t-1", risk_factor: "USD-IRS-3M", risk_value: 0.1, weight: 1.0, book: "DESK_A" } },
      { key: "k2", doc: { trade_id: "t-2", risk_factor: "USD-IRS-1Y", risk_value: 0.2, weight: 1.0, book: "DESK_B" } },
    ]);
    render(<CalcPanel />);
    await openUsdDrilldown();
    const sel = screen.getByTestId("bucket-drilldown-groupby-select") as HTMLSelectElement;
    const regionOpt = within(sel).getByRole("option", { name: "Region" }) as HTMLOptionElement;
    expect(regionOpt.disabled).toBe(true);
    expect(regionOpt.title).toMatch(/Not present on these rows/);
    const bookOpt = within(sel).getByRole("option", { name: "Book" }) as HTMLOptionElement;
    expect(bookOpt.disabled).toBe(false);
  });

  it("Σ exposure aggregates the four risk_value shapes (number, {spot}, {cvr_up,cvr_down} scalars, arrays)", async () => {
    fetchRouter([
      // Number scalar: |0.5 * 2| = 1
      { key: "n1", doc: { trade_id: "t-n1", book: "NUM", risk_value: 0.5, weight: 2 } },
      // {spot}: |1.5 * 2| = 3
      { key: "n2", doc: { trade_id: "t-n2", book: "SPOT", risk_value: { spot: 1.5 }, weight: 2 } },
      // {cvr_up, cvr_down} scalars: max(|3|,|−2|) * 2 = 6
      { key: "n3", doc: { trade_id: "t-n3", book: "CVR", risk_value: { cvr_up: 3, cvr_down: -2 }, weight: 2 } },
      // per-tenor array shape: Σ|v| = 1+2+3 = 6, weight 1 → 6
      { key: "n4", doc: { trade_id: "t-n4", book: "ARR", risk_value: { cvr_up: [1, -2], cvr_down: [3] }, weight: 1 } },
      // per-tenor object shape: Σ|v| = 0.1+0.2 = 0.3, weight 1 → 0.3
      { key: "n5", doc: { trade_id: "t-n5", book: "TEN", risk_value: { "3M": 0.1, "6M": -0.2 }, weight: 1 } },
    ]);
    render(<CalcPanel />);
    await openUsdDrilldown();
    fireEvent.change(screen.getByTestId("bucket-drilldown-groupby-select"), { target: { value: "book" } });
    const groups = screen.getAllByTestId("drilldown-group-row");
    const byKey = Object.fromEntries(
      groups.map((g) => [g.getAttribute("data-group-key"), within(g).getByTestId("drilldown-group-exposure").textContent ?? ""]),
    );
    expect(byKey["NUM"]).toBe("1.000");
    expect(byKey["SPOT"]).toBe("3.000");
    expect(byKey["CVR"]).toBe("6.000");
    expect(byKey["ARR"]).toBe("6.000");
    expect(byKey["TEN"]).toBe("0.3000");
    // Desc by exposure: CVR (6) and ARR (6) at the top, TEN (0.3) at the bottom.
    expect(groups[groups.length - 1]!.getAttribute("data-group-key")).toBe("TEN");
  });

  it("resets to None when the drilldown is closed and a new bucket is opened", async () => {
    fetchRouter(
      [
        { key: "k1", doc: { trade_id: "t-1", risk_factor: "USD-IRS-3M", risk_value: 0.1, weight: 1.0 } },
      ],
      {
        per_bucket: [
          { bucket: "USD", K_b: 200, S_b: 180, count: 5000, ms: 12 },
          { bucket: "EUR", K_b: 100, S_b: 90, count: 2500, ms: 7 },
        ],
      },
    );
    render(<CalcPanel />);
    await openUsdDrilldown();
    const sel = screen.getByTestId("bucket-drilldown-groupby-select") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "risk_factor" } });
    expect(sel.value).toBe("risk_factor");
    // Close USD, then open EUR — fresh drilldown should default back to None.
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "USD")!,
    );
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "EUR")!,
    );
    await waitFor(() => {
      const next = screen.getByTestId("bucket-drilldown-groupby-select") as HTMLSelectElement;
      expect(next.value).toBe("none");
    });
  });
});
