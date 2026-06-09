import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import type { TotalSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

// Wave 5.96B — Total SBM card tests. The 27-cell orchestrator is rendered
// alongside the per-cell Calculate card and surfaces the §21.4(8)
// max-over-scenarios charge plus parallelism evidence (wall-clock vs
// cumulative ms, parallelism factor) for the "Redis-fast" callout.

function buildTotalResponse(overrides: Partial<TotalSbmResponse> = {}): TotalSbmResponse {
  const classes = ["GIRR", "EQUITY", "FX"];
  const legs = ["delta", "vega", "curvature"] as const;
  const breakdown: TotalSbmResponse["breakdown"] = [];
  for (const c of classes) for (const l of legs) {
    breakdown.push({
      risk_class: c,
      leg: l,
      skipped: false,
      scenarios: {
        low: { charge: 0, ms: 1 },
        medium: { charge: 0, ms: 1 },
        high: { charge: c === "GIRR" && l === "delta" ? 100 : 0, ms: 1 },
      },
    });
  }
  return {
    total_sbm: 100,
    winning_scenario: "high",
    scenario_totals: { low: 0, medium: 0, high: 100 },
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

  it("on click, fetches /calc/sbm/total and renders charge, parallelism factor and matrix", async () => {
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
    expect(screen.getByText(/27 FT\.AGGREGATE\+FCALL fan-out/)).toBeInTheDocument();

    const matrix = screen.getByTestId("calc-total-matrix");
    const rows = matrix.querySelectorAll("tbody tr");
    expect(rows.length).toBe(9); // 3 classes × 3 legs

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
});
