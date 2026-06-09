import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import type { TotalSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

// Wave 5.96B/5.96C — Total SBM card tests. The 27-cell orchestrator is
// rendered alongside the per-cell Calculate card and surfaces (a) the
// §21.4(8) max-over-scenarios charge in a headline, (b) the KaTeX-rendered
// derivation (5.96C), (c) per-scenario / per-class subtotals, and (d)
// parallelism evidence for the "Redis-fast" callout.

function buildTotalResponse(overrides: Partial<TotalSbmResponse> = {}): TotalSbmResponse {
  // Distinct non-zero numbers for each (class, leg, scenario) so the per-class
  // subtotal assertions can verify Δ + V + Crv sums exactly. GIRR.high wins.
  const breakdown: TotalSbmResponse["breakdown"] = [
    // GIRR
    { risk_class: "GIRR", leg: "delta", skipped: false,
      scenarios: { low: { charge: 43.2, ms: 1 }, medium: { charge: 45.1, ms: 1 }, high: { charge: 46.8, ms: 1 } } },
    { risk_class: "GIRR", leg: "vega", skipped: false,
      scenarios: { low: { charge: 5.1, ms: 1 }, medium: { charge: 5.1, ms: 1 }, high: { charge: 5.1, ms: 1 } } },
    { risk_class: "GIRR", leg: "curvature", skipped: false,
      scenarios: { low: { charge: 8.9, ms: 1 }, medium: { charge: 9.2, ms: 1 }, high: { charge: 9.5, ms: 1 } } },
    // EQUITY — fully skipped so the per-class summary renders "(no data)".
    { risk_class: "EQUITY", leg: "delta", skipped: true,
      scenarios: { low: { charge: 0, ms: 0 }, medium: { charge: 0, ms: 0 }, high: { charge: 0, ms: 0 } } },
    { risk_class: "EQUITY", leg: "vega", skipped: true,
      scenarios: { low: { charge: 0, ms: 0 }, medium: { charge: 0, ms: 0 }, high: { charge: 0, ms: 0 } } },
    { risk_class: "EQUITY", leg: "curvature", skipped: true,
      scenarios: { low: { charge: 0, ms: 0 }, medium: { charge: 0, ms: 0 }, high: { charge: 0, ms: 0 } } },
    // FX
    { risk_class: "FX", leg: "delta", skipped: false,
      scenarios: { low: { charge: 124.0, ms: 1 }, medium: { charge: 125.0, ms: 1 }, high: { charge: 126.0, ms: 1 } } },
    { risk_class: "FX", leg: "vega", skipped: false,
      scenarios: { low: { charge: 38.4, ms: 1 }, medium: { charge: 38.4, ms: 1 }, high: { charge: 38.4, ms: 1 } } },
    { risk_class: "FX", leg: "curvature", skipped: false,
      scenarios: { low: { charge: 15.7, ms: 1 }, medium: { charge: 15.9, ms: 1 }, high: { charge: 16.1, ms: 1 } } },
  ];
  return {
    total_sbm: 241.9,
    winning_scenario: "high",
    scenario_totals: { low: 235.3, medium: 238.7, high: 241.9 },
    breakdown,
    unsupported_classes: ["csr_non_sec", "csr_sec_non_ctp", "csr_sec_ctp", "commodity"],
    performance: {
      total_ms: 15,
      cumulative_ms: 270,
      parallelism_factor: 18,
      redis_ops_count: 27,
      ops_skipped: 0,
    },
    resolved_command_summary: "27 FT.AGGREGATE+FCALL fan-out via /calc/sbm (3 classes × 3 legs × 3 scenarios)",
    ...overrides,
  };
}

function mockTotalResponse(body: TotalSbmResponse) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/calc/sbm/total")) {
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }
    // Anything else (facets etc.) returns an empty success so the panel mounts.
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("<CalcPanel /> — Total SBM card (Wave 5.96B)", () => {
  it("renders the Total SBM card with a Calculate Total SBM button", () => {
    render(<CalcPanel />);
    expect(screen.getByTestId("calc-total-cta")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /total sbm/i })).toBeInTheDocument();
  });

  it("on click, fetches /calc/sbm/total and renders charge, parallelism factor and scenario columns", async () => {
    mockTotalResponse(buildTotalResponse());
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-total-cta"));
    await waitFor(() => expect(screen.getByTestId("calc-total-result")).toBeInTheDocument());

    const parallelism = screen.getByTestId("calc-total-parallelism");
    expect(parseFloat(parallelism.textContent ?? "0")).toBeGreaterThan(2.0);

    const perf = screen.getByTestId("calc-total-performance");
    expect(perf.textContent).toMatch(/wall-clock/);
    expect(perf.textContent).toMatch(/cumulative/);
    expect(perf.textContent).toMatch(/27\/27 cells/);
    expect(perf.textContent).toMatch(/parallel speedup/);
    // The tooltip surfaces the full cumulative / wall-clock derivation.
    expect(perf.getAttribute("title") ?? "").toMatch(/Parallelism factor = cumulative \/ wall-clock/);

    expect(screen.getByText(/27 FT\.AGGREGATE\+FCALL fan-out/)).toBeInTheDocument();

    // Wave 5.96C — three scenario columns, each carrying the three class
    // groups (GIRR / EQUITY / FX). Replaces the old flat 9-row table.
    const matrix = screen.getByTestId("calc-total-matrix");
    const scenarioCols = matrix.querySelectorAll('[data-testid^="calc-total-scenario-"]');
    expect(scenarioCols.length).toBe(3);
    for (const col of Array.from(scenarioCols)) {
      const classes = col.querySelectorAll("[data-class]");
      expect(classes.length).toBe(3);
    }

    // Verify the correct endpoint was called.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((c) =>
      String(c[0]).includes("/calc/sbm/total"),
    )).toBe(true);
  });

  it("surfaces skipped cell counts in the performance strip", async () => {
    mockTotalResponse(buildTotalResponse({
      performance: {
        total_ms: 5, cumulative_ms: 100,
        parallelism_factor: 20, redis_ops_count: 18, ops_skipped: 9,
      },
    }));
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-total-cta"));
    await waitFor(() => expect(screen.getByTestId("calc-total-result")).toBeInTheDocument());
    expect(screen.getByTestId("calc-total-performance").textContent).toMatch(/9 skipped/);
  });

  it("renders an alert when the orchestrator request fails", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/calc/sbm/total")) {
        return new Response(JSON.stringify({ error: "discovery-failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-total-cta"));
    await waitFor(() => expect(screen.queryByTestId("calc-total-cta")?.textContent).toMatch(/Calculate Total SBM/i));
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  // Wave 5.96C — KaTeX-rendered §21.4(8) derivation. react-katex emits a
  // .katex container; checking its presence is enough to guarantee the
  // formula block was wired through the existing KaTeX integration.
  it("renders the §21.4(8) derivation through KaTeX (symbolic + substituted)", async () => {
    mockTotalResponse(buildTotalResponse());
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-total-cta"));
    await waitFor(() => expect(screen.getByTestId("calc-total-result")).toBeInTheDocument());

    const formula = screen.getByTestId("calc-total-formula");
    // Symbolic + substituted blocks both render a .katex element.
    expect(formula.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    const substituted = screen.getByTestId("calc-total-formula-substituted");
    expect(substituted.querySelector(".katex")).not.toBeNull();
    // "Show derivation for all scenarios" disclosure is present and yields
    // an additional KaTeX expression per scenario when opened.
    const allDeriv = screen.getByTestId("calc-total-formula-all");
    fireEvent.click(allDeriv.querySelector("summary")!);
    expect(allDeriv.querySelectorAll(".katex").length).toBe(3);
  });

  // Wave 5.96C — per-class subtotals must equal Σ(Δ + V + Crv) over the
  // non-skipped legs of the scenario column. We use the GIRR / FX rows
  // from buildTotalResponse() under the winning (high) scenario.
  it("computes per-class subtotals correctly from scenarios.{low,med,high}.charge", async () => {
    mockTotalResponse(buildTotalResponse());
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-total-cta"));
    await waitFor(() => expect(screen.getByTestId("calc-total-result")).toBeInTheDocument());

    const highCol = screen.getByTestId("calc-total-scenario-high");
    const girr = highCol.querySelector('[data-class="GIRR"]') as HTMLElement;
    // Δ 46.80 + V 5.10 + Crv 9.50 = 61.40
    expect(within(girr).getByText("61.400")).toBeInTheDocument();
    const fx = highCol.querySelector('[data-class="FX"]') as HTMLElement;
    // Δ 126.00 + V 38.40 + Crv 16.10 = 180.50
    expect(within(fx).getByText("180.50")).toBeInTheDocument();

    // The low column subtotal for FX: 124.0 + 38.4 + 15.7 = 178.10
    const lowCol = screen.getByTestId("calc-total-scenario-low");
    const fxLow = lowCol.querySelector('[data-class="FX"]') as HTMLElement;
    expect(within(fxLow).getByText("178.10")).toBeInTheDocument();
  });

  // Wave 5.96C — the winning scenario column gets the --winner modifier
  // class so the visual tint is applied; non-winning columns must not.
  it("marks the winning scenario column with the --winner modifier", async () => {
    mockTotalResponse(buildTotalResponse());
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-total-cta"));
    await waitFor(() => expect(screen.getByTestId("calc-total-result")).toBeInTheDocument());

    const highCol = screen.getByTestId("calc-total-scenario-high");
    expect(highCol.className).toMatch(/calc-panel__total-scenario--winner/);
    expect(highCol.getAttribute("data-winner")).toBe("true");
    const lowCol = screen.getByTestId("calc-total-scenario-low");
    expect(lowCol.className).not.toMatch(/--winner/);
    expect(lowCol.getAttribute("data-winner")).toBe("false");

    // Headline pill carries the winning scenario name in upper case.
    expect(screen.getByTestId("calc-total-winner-pill").textContent).toMatch(/HIGH/);
  });

  // Wave 5.96C — fully-skipped classes (e.g. EQUITY when no sensitivities
  // exist for any leg) render as "(no data)" instead of "$0.00", so the
  // empty vs. computed-zero distinction is visible.
  it("renders fully-skipped classes as '(no data)' rather than $0.00", async () => {
    mockTotalResponse(buildTotalResponse());
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-total-cta"));
    await waitFor(() => expect(screen.getByTestId("calc-total-result")).toBeInTheDocument());

    const highCol = screen.getByTestId("calc-total-scenario-high");
    const equity = highCol.querySelector('[data-class="EQUITY"]') as HTMLElement;
    expect(equity.className).toMatch(/calc-panel__total-class--empty/);
    expect(within(equity).getByText("(no data)")).toBeInTheDocument();
    // The "(no data)" treatment supplants any "$0.00" / "0.000" charge line.
    expect(within(equity).queryByText(/^0\.000$/)).toBeNull();
  });
});
