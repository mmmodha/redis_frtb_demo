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
  per_bucket: [
    { bucket: "USD", K_b: 200, S_b: 180, count: 5000, ms: 12 },
    { bucket: "EUR", K_b: 100, S_b: 90, count: 2500, ms: 7 },
  ],
  total_ms: 1500.4,
  shard_breakdown: [{ shard: "shard-1", buckets: ["USD", "EUR"], ms: 0 }],
  fanout_ms: 14.6,
};

interface PivotRowFixture {
  key: string;
  doc: { trade_id?: string; risk_factor?: string; risk_value?: unknown; weight?: number };
}

function fetchRouter(handlers: {
  calc?: (req: { url: string }) => Response | Promise<Response>;
  pivot?: (req: { url: string; offset: number }) => Response | Promise<Response>;
}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/calc/sbm")) {
      if (handlers.calc) return handlers.calc({ url });
      return new Response(JSON.stringify(calcResponse), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/pivot")) {
      const m = url.match(/[?&]offset=(\d+)/);
      const offset = m ? Number(m[1]) : 0;
      if (handlers.pivot) return handlers.pivot({ url, offset });
      return new Response(JSON.stringify({ rows: [], total: 0, limit: 20, offset, ms: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function runCalc(button: HTMLElement) {
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
}

describe("CalcPanel Wave 5.18 polish + drill-down", () => {
  it("Curvature is selectable and renders a result table", async () => {
    fetchRouter({});
    render(<CalcPanel />);
    const st = screen.getByLabelText(/sensitivity type/i) as HTMLSelectElement;
    expect(within(st).getByRole("option", { name: "Curvature" })).toBeInTheDocument();
    fireEvent.change(st, { target: { value: "Curvature" } });
    expect(st.value).toBe("Curvature");
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    expect(screen.getByRole("table", { name: /per-bucket/i })).toBeInTheDocument();
  });

  it("Basel caption switches when sensitivity type changes", async () => {
    fetchRouter({});
    render(<CalcPanel />);
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    const cap1 = screen.getByTestId("basel-caption").textContent ?? "";
    expect(cap1).toMatch(/§21\.4\(5\)/);
    expect(cap1).toMatch(/GIRR.*Delta/);

    // Change sensitivity, recompute → caption updates per §21.5(5) for Curvature.
    fireEvent.change(screen.getByLabelText(/sensitivity type/i), { target: { value: "Curvature" } });
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    const cap2 = screen.getByTestId("basel-caption").textContent ?? "";
    expect(cap2).toMatch(/§21\.5\(5\)/);
    expect(cap2).toMatch(/Curvature/);
  });

  it("Clicking a bucket row opens a drill-down with the matching trade list", async () => {
    const rows: PivotRowFixture[] = [
      { key: "sens:{GIRR:USD}:t-1", doc: { trade_id: "t-1", risk_factor: "USD-IRS-3M", risk_value: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], weight: 1.5 } },
      { key: "sens:{GIRR:USD}:t-2", doc: { trade_id: "t-2", risk_factor: "USD-IRS-1Y", risk_value: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1], weight: 1.7 } },
    ];
    fetchRouter({
      pivot: () =>
        new Response(JSON.stringify({ rows, total: 2, limit: 20, offset: 0, ms: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    render(<CalcPanel />);
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));

    const chart = screen.getByTestId("bucket-chart");
    const usdRow = within(chart)
      .getAllByTestId("bucket-chart-row")
      .find((r) => r.getAttribute("data-bucket") === "USD")!;
    expect(usdRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(usdRow);
    expect(usdRow.getAttribute("aria-expanded")).toBe("true");

    await waitFor(() => {
      expect(screen.getAllByTestId("drilldown-row").length).toBe(2);
    });
    const trades = screen.getAllByTestId("drilldown-row").map((r) => r.getAttribute("data-trade-id"));
    expect(trades).toContain("t-1");
    expect(trades).toContain("t-2");
  });

  it("Equity Delta drill-down shows {spot} as a single numeric cell", async () => {
    const rows: PivotRowFixture[] = [
      { key: "sens:{Equity:6}:e-1", doc: { trade_id: "e-1", risk_factor: "AAPL", risk_value: { spot: 12.345 }, weight: 0.75 } },
    ];
    fetchRouter({
      calc: () =>
        new Response(
          JSON.stringify({
            ...calcResponse,
            per_bucket: [{ bucket: "6", K_b: 50, S_b: 40, count: 100, ms: 2 }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      pivot: () =>
        new Response(JSON.stringify({ rows, total: 1, limit: 20, offset: 0, ms: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    render(<CalcPanel />);
    fireEvent.change(screen.getByLabelText(/risk class/i), { target: { value: "Equity" } });
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    const chart = screen.getByTestId("bucket-chart");
    fireEvent.click(within(chart).getAllByTestId("bucket-chart-row")[0]!);
    await waitFor(() => expect(screen.getByTestId("drilldown-row")).toBeInTheDocument());
    const scalar = screen.getByTestId("drilldown-scalar");
    expect(scalar.textContent).toMatch(/12\.345/);
    // No sparkline rendered for Equity Delta scalar.
    expect(screen.queryByTestId("sparkline")).toBeNull();
  });

  it("Load 20 more increments offset and appends rows", async () => {
    const makeRows = (start: number, n: number): PivotRowFixture[] =>
      Array.from({ length: n }, (_, i) => ({
        key: `k-${start + i}`,
        doc: { trade_id: `t-${start + i}`, risk_factor: "RF", risk_value: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      }));
    const offsets: number[] = [];
    fetchRouter({
      pivot: ({ offset }) => {
        offsets.push(offset);
        const page = offset === 0 ? makeRows(0, 20) : makeRows(20, 10);
        return new Response(JSON.stringify({ rows: page, total: 30, limit: 20, offset, ms: 1 }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    render(<CalcPanel />);
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "USD")!,
    );
    await waitFor(() => expect(screen.getAllByTestId("drilldown-row").length).toBe(20));
    fireEvent.click(screen.getByTestId("bucket-drilldown-load-more"));
    await waitFor(() => expect(screen.getAllByTestId("drilldown-row").length).toBe(30));
    expect(offsets).toEqual([0, 20]);
    // At offset+limit >= total the button disables.
    expect(screen.getByTestId("bucket-drilldown-load-more")).toBeDisabled();
  });

  it("Drill-down with /pivot 503 renders empty-target banner, panel stays alive", async () => {
    fetchRouter({
      pivot: () =>
        new Response(
          JSON.stringify({ error: "no-data-or-index", risk_class: "GIRR", hint: "ingest data first" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    });
    render(<CalcPanel />);
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "USD")!,
    );
    await waitFor(() => expect(screen.getByTestId("bucket-drilldown-empty")).toBeInTheDocument());
    // CalcPanel headline charge survives.
    expect(screen.getByTestId("calc-charge")).toBeInTheDocument();
  });
});
