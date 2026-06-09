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
    const st = screen.getByLabelText(/^sensitivity$/i) as HTMLSelectElement;
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
    fireEvent.change(screen.getByLabelText(/^sensitivity$/i), { target: { value: "Curvature" } });
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

  // Wave 5.21a: post-5.17a, GIRR Delta/Vega risk_value is a tenor-keyed object.
  // The drilldown must reshape that into a positional 10-tenor array so the
  // sparkline renders values instead of falling back to the "—" empty state.
  it("Wave 5.21a: GIRR Delta drill-down renders sparkline from tenor-keyed risk_value", async () => {
    const rv = { "3M": 0.063515, "6M": 0.12, "1Y": 0.25, "2Y": 0.4, "3Y": 0.55,
                 "5Y": 0.7, "10Y": 0.85, "15Y": 0.9, "20Y": 0.95, "30Y": 1.0 };
    const rows: PivotRowFixture[] = [
      { key: "sens:{GIRR:USD}:t-k1", doc: { trade_id: "t-k1", risk_factor: "USD-IRS", risk_value: rv, weight: 1.5 } },
    ];
    fetchRouter({
      pivot: () =>
        new Response(JSON.stringify({ rows, total: 1, limit: 20, offset: 0, ms: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    render(<CalcPanel />);
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "USD")!,
    );
    await waitFor(() => expect(screen.getByTestId("drilldown-row")).toBeInTheDocument());
    const sp = screen.getByTestId("sparkline");
    expect(sp.classList.contains("sparkline--empty")).toBe(false);
    expect(sp.getAttribute("aria-label")).toMatch(/Delta 10-tenor curve/);
    // No "—" placeholder in the rendered cell.
    expect(within(screen.getByTestId("drilldown-row")).queryByText("—")).toBeNull();
  });

  it("Wave 5.21a: GIRR Vega drill-down renders sparkline from tenor-keyed risk_value", async () => {
    const rv = { "3M": -0.1, "6M": -0.05, "1Y": 0.0, "2Y": 0.05, "3Y": 0.1,
                 "5Y": 0.15, "10Y": 0.2, "15Y": 0.25, "20Y": 0.3, "30Y": 0.35 };
    const rows: PivotRowFixture[] = [
      { key: "sens:{GIRR:USD}:t-v1", doc: { trade_id: "t-v1", risk_factor: "USD-IRSVOL", risk_value: rv, weight: 1.0 } },
    ];
    fetchRouter({
      pivot: () =>
        new Response(JSON.stringify({ rows, total: 1, limit: 20, offset: 0, ms: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    render(<CalcPanel />);
    fireEvent.change(screen.getByLabelText(/^sensitivity$/i), { target: { value: "Vega" } });
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "USD")!,
    );
    await waitFor(() => expect(screen.getByTestId("drilldown-row")).toBeInTheDocument());
    const sp = screen.getByTestId("sparkline");
    expect(sp.classList.contains("sparkline--empty")).toBe(false);
    expect(sp.getAttribute("aria-label")).toMatch(/Vega 10-tenor curve/);
  });

  it("Wave 5.21a: GIRR Curvature drill-down renders 2-series sparkline from cvr_up/cvr_down arrays", async () => {
    const rv = {
      cvr_up: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      cvr_down: [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8, -0.9, -1.0],
    };
    const rows: PivotRowFixture[] = [
      { key: "sens:{GIRR:USD}:t-c1", doc: { trade_id: "t-c1", risk_factor: "USD-CURV", risk_value: rv, weight: 1.0 } },
    ];
    fetchRouter({
      pivot: () =>
        new Response(JSON.stringify({ rows, total: 1, limit: 20, offset: 0, ms: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    render(<CalcPanel />);
    fireEvent.change(screen.getByLabelText(/^sensitivity$/i), { target: { value: "Curvature" } });
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "USD")!,
    );
    await waitFor(() => expect(screen.getByTestId("drilldown-row")).toBeInTheDocument());
    const sp = screen.getByTestId("sparkline");
    expect(sp.classList.contains("sparkline--empty")).toBe(false);
    expect(sp.getAttribute("data-series")).toBe("2");
  });

  it("Wave 5.21a: Equity Curvature drill-down reads cvr_up/cvr_down scalars (not up/down)", async () => {
    const rows: PivotRowFixture[] = [
      { key: "sens:{Equity:6}:e-c1", doc: { trade_id: "e-c1", risk_factor: "AAPL", risk_value: { cvr_up: 3.21, cvr_down: -2.15 }, weight: 0.75 } },
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
    fireEvent.change(screen.getByLabelText(/^sensitivity$/i), { target: { value: "Curvature" } });
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    const chart = screen.getByTestId("bucket-chart");
    fireEvent.click(within(chart).getAllByTestId("bucket-chart-row")[0]!);
    await waitFor(() => expect(screen.getByTestId("drilldown-row")).toBeInTheDocument());
    const pill = screen.getByTestId("drilldown-curv-pill");
    expect(pill.textContent ?? "").toMatch(/3\.21/);
    expect(pill.textContent ?? "").toMatch(/2\.15/);
    expect(pill.textContent ?? "").not.toMatch(/—/);
  });

  it("Wave 5.21a: FX Delta drill-down renders {spot} scalar cell with no placeholder", async () => {
    const rows: PivotRowFixture[] = [
      { key: "sens:{FX:EURUSD}:f-1", doc: { trade_id: "f-1", risk_factor: "EURUSD", risk_value: { spot: 0.4321 }, weight: 1.0 } },
    ];
    fetchRouter({
      calc: () =>
        new Response(
          JSON.stringify({
            ...calcResponse,
            per_bucket: [{ bucket: "EURUSD", K_b: 50, S_b: 40, count: 100, ms: 2 }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      pivot: () =>
        new Response(JSON.stringify({ rows, total: 1, limit: 20, offset: 0, ms: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    render(<CalcPanel />);
    fireEvent.change(screen.getByLabelText(/risk class/i), { target: { value: "FX" } });
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    fireEvent.click(within(screen.getByTestId("bucket-chart")).getAllByTestId("bucket-chart-row")[0]!);
    await waitFor(() => expect(screen.getByTestId("drilldown-row")).toBeInTheDocument());
    const scalar = screen.getByTestId("drilldown-scalar");
    expect(scalar.textContent ?? "").toMatch(/0\.4321/);
    expect(scalar.textContent ?? "").not.toMatch(/^—$/);
  });

  it("Wave 5.21a: legacy GIRR Delta number[] risk_value still renders (backwards-compat fallback)", async () => {
    const rows: PivotRowFixture[] = [
      { key: "sens:{GIRR:USD}:t-legacy", doc: { trade_id: "t-legacy", risk_factor: "USD-IRS", risk_value: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], weight: 1.5 } },
    ];
    fetchRouter({
      pivot: () =>
        new Response(JSON.stringify({ rows, total: 1, limit: 20, offset: 0, ms: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    render(<CalcPanel />);
    await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    fireEvent.click(
      within(screen.getByTestId("bucket-chart"))
        .getAllByTestId("bucket-chart-row")
        .find((r) => r.getAttribute("data-bucket") === "USD")!,
    );
    await waitFor(() => expect(screen.getByTestId("drilldown-row")).toBeInTheDocument());
    const sp = screen.getByTestId("sparkline");
    expect(sp.classList.contains("sparkline--empty")).toBe(false);
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

  // Wave 5.96A — per-bucket K_b drilldown: formula block (with substituted
  // numbers) + Redis command block. Fast-path responses render the closed
  // form pieces from `intermediate.{ws_squared_sum, cross_term}`; Lua-path
  // responses (intermediate.path === "lua") render a "not surfaced" message.
  describe("Wave 5.96A: K_b formula + Redis command block", () => {
    it("Fast path renders symbolic + substituted formula and the resolved FT.AGGREGATE", async () => {
      fetchRouter({
        calc: () =>
          new Response(JSON.stringify({
            ...calcResponse,
            per_bucket: [{
              bucket: "USD", K_b: 8.66025, S_b: 10, count: 5, ms: 3.2,
              intermediate: { path: "fast", ws_squared_sum: 50, cross_term: 25 },
              resolved_command: "FT.AGGREGATE idx:sens '@risk_class:{GIRR} @sensitivity_type:{Delta} @bucket:{USD}' APPLY '...' GROUPBY 1 @bucket",
            }],
          }), { headers: { "content-type": "application/json" } }),
      });
      render(<CalcPanel />);
      await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
      fireEvent.click(
        within(screen.getByTestId("bucket-chart"))
          .getAllByTestId("bucket-chart-row")
          .find((r) => r.getAttribute("data-bucket") === "USD")!,
      );
      await waitFor(() => expect(screen.getByTestId("bucket-drilldown-kb")).toBeInTheDocument());
      // Formula block surfaces the substituted numbers (50, 25, K_b).
      const sub = screen.getByTestId("bucket-drilldown-formula-substituted").textContent ?? "";
      expect(sub).toContain("50.00000");
      expect(sub).toContain("25.00000");
      expect(sub).toContain("8.66025");
      // S_b line: 10 (5 sensitivities).
      const sb = screen.getByTestId("bucket-drilldown-formula-sb").textContent ?? "";
      expect(sb).toContain("10.00000");
      expect(sb).toContain("5 sensitivities");
      // Redis command block + the FT.AGGREGATE string + the ms badge.
      const cmdHeading = screen.getByTestId("bucket-drilldown-command").textContent ?? "";
      expect(cmdHeading).toContain("3.2 ms");
      expect(screen.getByTestId("bucket-drilldown-command-pre").textContent)
        .toMatch(/^FT\.AGGREGATE/);
    });

    it("Curvature fast path: surfaces K_b^+ and K_b^- with the winner label", async () => {
      fetchRouter({
        calc: () =>
          new Response(JSON.stringify({
            ...calcResponse,
            per_bucket: [{
              bucket: "USD", K_b: Math.sqrt(14.5), S_b: 4, count: 3, ms: 4.1,
              intermediate: {
                path: "fast", ws_squared_sum: 14, cross_term: 0.5,
                curvature: { k_plus: Math.sqrt(14.5), k_minus: Math.sqrt(4.5), winner: "plus" },
              },
              resolved_command: "FT.AGGREGATE idx:sens '@risk_class:{GIRR} @sensitivity_type:{Curvature} @bucket:{USD}' APPLY '...'",
            }],
          }), { headers: { "content-type": "application/json" } }),
      });
      render(<CalcPanel />);
      fireEvent.change(screen.getByLabelText(/^sensitivity$/i), { target: { value: "Curvature" } });
      await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
      fireEvent.click(
        within(screen.getByTestId("bucket-chart"))
          .getAllByTestId("bucket-chart-row")
          .find((r) => r.getAttribute("data-bucket") === "USD")!,
      );
      await waitFor(() => expect(screen.getByTestId("bucket-drilldown-formula-curvature")).toBeInTheDocument());
      const curv = screen.getByTestId("bucket-drilldown-formula-curvature").textContent ?? "";
      // KaTeX collapses whitespace inside the rendered math — assert on the
      // numeric tokens we substituted, not on the surrounding LaTeX commands.
      expect(curv).toContain(Math.sqrt(14.5).toFixed(5));
      expect(curv).toContain(Math.sqrt(4.5).toFixed(5));
      expect(curv).toMatch(/winner/);
    });

    it("Lua path: shows 'computed in Lua FCALL, intermediates not surfaced'", async () => {
      fetchRouter({
        calc: () =>
          new Response(JSON.stringify({
            ...calcResponse,
            engine: "fcall_lua",
            per_bucket: [{
              bucket: "USD", K_b: 3, S_b: 3, count: 5, ms: 1.0,
              intermediate: { path: "lua" },
              resolved_command: "FCALL sbm_delta_bucket 1 sens:{GIRR:USD}:_route GIRR USD",
            }],
          }), { headers: { "content-type": "application/json" } }),
      });
      render(<CalcPanel />);
      await runCalc(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
      fireEvent.click(
        within(screen.getByTestId("bucket-chart"))
          .getAllByTestId("bucket-chart-row")
          .find((r) => r.getAttribute("data-bucket") === "USD")!,
      );
      await waitFor(() => expect(screen.getByTestId("bucket-drilldown-formula-lua")).toBeInTheDocument());
      const lua = screen.getByTestId("bucket-drilldown-formula-lua").textContent ?? "";
      expect(lua).toMatch(/computed in Lua FCALL/);
      expect(lua).toMatch(/not surfaced/);
      // No substituted block on the Lua path (no intermediates surfaced).
      expect(screen.queryByTestId("bucket-drilldown-formula-substituted")).toBeNull();
      // Command block still renders the FCALL string.
      expect(screen.getByTestId("bucket-drilldown-command-pre").textContent)
        .toMatch(/^FCALL sbm_delta_bucket/);
    });
  });
});
