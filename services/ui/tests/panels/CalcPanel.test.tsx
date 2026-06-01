import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import type { CalcSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

function mockCalcResponse(body: CalcSbmResponse | { error: string }, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as typeof fetch;
}

// Wave 5.21e: helper for tests that need to exercise both the /calc/sbm POST
// and the /pivot GET (drill-down). Routes per-URL so the drill-down body and
// the calc body don't have to share a shape.
function mockCalcAndPivotResponses(calcBody: CalcSbmResponse, pivotBody: unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.includes("/pivot") ? pivotBody : calcBody;
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function deferredCalcResponse(body: CalcSbmResponse) {
  let resolveFn: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  globalThis.fetch = vi.fn(async () => {
    await released;
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return resolveFn;
}

const baseResponse: CalcSbmResponse = {
  charge: 1234567.89,
  per_bucket: [
    { bucket: "USD-IRS", K_b: 200, S_b: 180, count: 5000, ms: 12 },
    { bucket: "EUR-IRS", K_b: 100, S_b: 90, count: 2500, ms: 7 },
    { bucket: "JPY-IRS", K_b: 50, S_b: 45, count: 1000, ms: 5 },
  ],
  total_ms: 1500.4,
  shard_breakdown: [
    { shard: "shard-1", buckets: ["USD-IRS"], ms: 12 },
    { shard: "shard-2", buckets: ["EUR-IRS"], ms: 7 },
    { shard: "shard-3", buckets: ["JPY-IRS"], ms: 5 },
  ],
  fanout_ms: 14.6,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("<CalcPanel />", () => {
  it("renders the Calc heading and a dominant Calculate SBM risk charge button", () => {
    render(<CalcPanel />);
    expect(screen.getByRole("heading", { name: /^Calc$/, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /calculate sbm risk charge/i })).toBeInTheDocument();
  });

  it("renders risk_class and sensitivity_type selectors with GIRR/Delta defaults", () => {
    render(<CalcPanel />);
    const rc = screen.getByLabelText(/risk class/i) as HTMLSelectElement;
    const st = screen.getByLabelText(/sensitivity type/i) as HTMLSelectElement;
    expect(rc.value).toBe("GIRR");
    expect(st.value).toBe("Delta");
    expect(within(rc).getByRole("option", { name: /GIRR/ })).toBeInTheDocument();
    expect(within(rc).getByRole("option", { name: /Equity/ })).toBeInTheDocument();
    expect(within(rc).getByRole("option", { name: /FX/ })).toBeInTheDocument();
    expect(within(st).getByRole("option", { name: "Delta" })).toBeInTheDocument();
    expect(within(st).getByRole("option", { name: "Vega" })).toBeInTheDocument();
  });

  it("shows a Wave 4 badge when Equity or FX is selected", () => {
    render(<CalcPanel />);
    const rc = screen.getByLabelText(/risk class/i) as HTMLSelectElement;
    expect(screen.queryByText(/wave 4/i)).toBeNull();
    fireEvent.change(rc, { target: { value: "Equity" } });
    expect(screen.getByText(/wave 4/i)).toBeInTheDocument();
    fireEvent.change(rc, { target: { value: "FX" } });
    expect(screen.getByText(/wave 4/i)).toBeInTheDocument();
    fireEvent.change(rc, { target: { value: "GIRR" } });
    expect(screen.queryByText(/wave 4/i)).toBeNull();
  });

  it("renders three EnterpriseCallout banners for in-database compute / map-reduce / hash-tag locality", () => {
    render(<CalcPanel />);
    const callouts = screen.getAllByText(/buying signal/i);
    expect(callouts.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("In-database compute")).toBeInTheDocument();
    expect(screen.getByText("Map-Reduce")).toBeInTheDocument();
    expect(screen.getByText("Hash-tag locality")).toBeInTheDocument();
  });

  it("renders an empty-state hint before the first calc", () => {
    render(<CalcPanel />);
    expect(screen.getByText(/press calculate/i)).toBeInTheDocument();
  });

  it("disables the button and shows a loading state while the calc is in flight", async () => {
    const release = deferredCalcResponse(baseResponse);
    render(<CalcPanel />);
    const button = screen.getByRole("button", { name: /calculate sbm risk charge/i });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText(/calculating/i)).toBeInTheDocument();
    release();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("renders the headline charge and per-bucket table on success", async () => {
    mockCalcResponse(baseResponse);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    const charge = screen.getByTestId("calc-charge");
    expect(charge.textContent).toMatch(/1[,\s]?234[,\s]?567/);
    const table = screen.getByRole("table", { name: /per-bucket/i });
    expect(within(table).getByText("USD-IRS")).toBeInTheDocument();
    expect(within(table).getByText("EUR-IRS")).toBeInTheDocument();
    expect(within(table).getByText("JPY-IRS")).toBeInTheDocument();
  });

  it("renders the TimingStrip with per-shard timings from shard_breakdown", async () => {
    mockCalcResponse(baseResponse);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByText("shard-1")).toBeInTheDocument());
    expect(screen.getByText("shard-2")).toBeInTheDocument();
    expect(screen.getByText("shard-3")).toBeInTheDocument();
    expect(screen.getByText(/12 ms/)).toBeInTheDocument();
  });

  it("sorts the per-bucket table by K_b descending when the K_b header is clicked", async () => {
    mockCalcResponse(baseResponse);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    const initialRows = screen.getAllByTestId("bucket-row").map((r) => r.getAttribute("data-bucket"));
    expect(initialRows).toEqual(["USD-IRS", "EUR-IRS", "JPY-IRS"]);
    fireEvent.click(screen.getByRole("button", { name: /sort by k_b/i }));
    const sortedRows = screen.getAllByTestId("bucket-row").map((r) => r.getAttribute("data-bucket"));
    expect(sortedRows).toEqual(["USD-IRS", "EUR-IRS", "JPY-IRS"]);
    fireEvent.click(screen.getByRole("button", { name: /sort by count/i }));
    const byCount = screen.getAllByTestId("bucket-row").map((r) => r.getAttribute("data-bucket"));
    expect(byCount[0]).toBe("USD-IRS");
  });

  // Wave 5.16m: surfaces the Redis commands the api dispatched.
  it("Wave 5.16m: renders the Redis commands panel with FT.AGGREGATE query and FCALL function verbatim when commands are present", async () => {
    const responseWithCommands: CalcSbmResponse = {
      ...baseResponse,
      commands: {
        discovery: {
          command: "FT.AGGREGATE",
          index: "idx:sens",
          query: "@risk_class:{GIRR}",
          groupby: ["@bucket"],
          reducers: ["COUNT 0 AS n"],
        },
        fcall: {
          command: "FCALL",
          function: "sbm_delta_bucket",
          library: "frtb",
          arg_template: "FCALL sbm_delta_bucket 1 sens:{GIRR:<bucket>}:_route GIRR <bucket>",
          dispatched_keys: [
            "sens:{GIRR:USD-IRS}:_route",
            "sens:{GIRR:EUR-IRS}:_route",
            "sens:{GIRR:JPY-IRS}:_route",
          ],
        },
      },
    };
    mockCalcResponse(responseWithCommands);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /redis commands executed/i })).toBeInTheDocument(),
    );
    const region = screen.getByTestId("redis-commands");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("discovery-command").textContent).toContain("@risk_class:{GIRR}");
    expect(screen.getByTestId("discovery-command").textContent).toContain("FT.AGGREGATE idx:sens");
    expect(screen.getByTestId("fcall-function").textContent).toBe("sbm_delta_bucket");
    expect(screen.getByTestId("fcall-library").textContent).toBe("frtb");
    expect(screen.getByTestId("fcall-command").textContent).toContain("sbm_delta_bucket");
    // Collapsible details lists the dispatched routing keys.
    const details = screen.getByTestId("fcall-dispatched-keys");
    expect(details.textContent).toContain("sens:{GIRR:USD-IRS}:_route");
    expect(details.textContent).toContain("sens:{GIRR:EUR-IRS}:_route");
  });

  it("Wave 5.16m: does NOT render the Redis commands panel when commands are absent (back-compat)", async () => {
    mockCalcResponse(baseResponse);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: /redis commands executed/i })).toBeNull();
    expect(screen.queryByTestId("redis-commands")).toBeNull();
  });

  // Wave 5.16n: standalone Redis has a single shard with sub-ms FCALL, so
  // per-shard timing is noise — suppress the panel entirely in that case.
  it("Wave 5.16n: suppresses the per-shard timing panel on standalone (single shard / all zero ms)", async () => {
    const standalone: CalcSbmResponse = {
      ...baseResponse,
      shard_breakdown: [{ shard: "shard-1", buckets: ["USD-IRS", "EUR-IRS", "JPY-IRS"], ms: 0 }],
    };
    mockCalcResponse(standalone);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    expect(screen.queryByText(/per-shard timing/i)).toBeNull();
  });

  it("Wave 5.16n: still renders the per-shard timing panel on multi-shard cluster with non-zero ms", async () => {
    mockCalcResponse(baseResponse);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    expect(screen.getByText(/per-shard timing/i)).toBeInTheDocument();
  });

  it("Wave 5.16n: renders the per-bucket K_b chart sorted by K_b descending alongside the table", async () => {
    const varied: CalcSbmResponse = {
      ...baseResponse,
      per_bucket: [
        { bucket: "EUR-IRS", K_b: 100, S_b: 90, count: 2500, ms: 7 },
        { bucket: "USD-IRS", K_b: 200, S_b: 180, count: 5000, ms: 12 },
        { bucket: "JPY-IRS", K_b: 50, S_b: 45, count: 1000, ms: 5 },
      ],
    };
    mockCalcResponse(varied);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("bucket-chart")).toBeInTheDocument());
    const chart = screen.getByTestId("bucket-chart");
    const table = screen.getByRole("table", { name: /per-bucket/i });
    for (const name of ["USD-IRS", "EUR-IRS", "JPY-IRS"]) {
      expect(within(chart).getByText(name)).toBeInTheDocument();
      expect(within(table).getByText(name)).toBeInTheDocument();
    }
    const chartOrder = within(chart)
      .getAllByTestId("bucket-chart-row")
      .map((r) => r.getAttribute("data-bucket"));
    expect(chartOrder[0]).toBe("USD-IRS");
    expect(chartOrder).toEqual(["USD-IRS", "EUR-IRS", "JPY-IRS"]);
  });

  // Wave 5.19: branch badge surfaces the §21.5(5) / §21.5(5)(b) decision
  // from the api beside the hero charge tile. Three guard-rail checks:
  // (a) badge present on curvature result, (b) absent for Delta result,
  // (c) absent before the first calc.
  it("Wave 5.19: renders the curvature-branch pill with the §21.5(5) label on positive_interior", async () => {
    const curvatureResp: CalcSbmResponse = {
      ...baseResponse,
      curvature_branch: "positive_interior",
    };
    mockCalcResponse(curvatureResp);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("curvature-branch-pill")).toBeInTheDocument());
    const pill = screen.getByTestId("curvature-branch-pill");
    expect(pill).toHaveAttribute("data-branch", "positive_interior");
    expect(pill.textContent).toMatch(/§21\.5\(5\)/);
    expect(pill.textContent).toMatch(/positive interior/i);
    expect(pill.getAttribute("title")).toMatch(/standard §21\.5\(5\)/);
  });

  it("Wave 5.19: switches to amber §21.5(5)(b) labelling on fallback_clipped_s", async () => {
    const curvatureResp: CalcSbmResponse = {
      ...baseResponse,
      curvature_branch: "fallback_clipped_s",
    };
    mockCalcResponse(curvatureResp);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("curvature-branch-pill")).toBeInTheDocument());
    const pill = screen.getByTestId("curvature-branch-pill");
    expect(pill).toHaveAttribute("data-branch", "fallback_clipped_s");
    expect(pill.textContent).toMatch(/§21\.5\(5\)\(b\)/);
    expect(pill.textContent).toMatch(/clipped/i);
    expect(pill.getAttribute("title")).toMatch(/interior was negative/);
  });

  it("Wave 5.19: omits the curvature-branch pill from Delta/Vega responses", async () => {
    mockCalcResponse(baseResponse); // no curvature_branch field
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    expect(screen.queryByTestId("curvature-branch-pill")).toBeNull();
  });

  it("Wave 5.19: the curvature-branch pill is absent before the first calc", () => {
    render(<CalcPanel />);
    expect(screen.queryByTestId("curvature-branch-pill")).toBeNull();
  });

  it("Wave 5.16n: tones the dominant bucket bar red when its K_b share exceeds 40%", async () => {
    const skewed: CalcSbmResponse = {
      ...baseResponse,
      per_bucket: [
        { bucket: "USD-IRS", K_b: 100, S_b: 90, count: 5000, ms: 12 },
        { bucket: "EUR-IRS", K_b: 60, S_b: 50, count: 2500, ms: 7 },
        { bucket: "JPY-IRS", K_b: 40, S_b: 30, count: 1000, ms: 5 },
      ],
    };
    mockCalcResponse(skewed);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("bucket-chart")).toBeInTheDocument());
    const chart = screen.getByTestId("bucket-chart");
    const rows = within(chart).getAllByTestId("bucket-chart-row");
    const usdRow = rows.find((r) => r.getAttribute("data-bucket") === "USD-IRS");
    expect(usdRow).toBeDefined();
    const fill = usdRow!.querySelector(".bucket-chart__bar-fill");
    expect(fill).not.toBeNull();
    expect(fill!.getAttribute("data-tone")).toBe("red");
  });

  // Wave 5.21e: clicking a trade_id pill in the bucket drill-down opens a
  // side drawer with the full row JSON, supports Escape + Copy JSON, and
  // restores focus to the originating pill on close.
  describe("Wave 5.21e: trade_id → JSON drilldown drawer", () => {
    const pivotDoc = {
      trade_id: "T-42",
      risk_class: "GIRR",
      bucket: "USD-IRS",
      sensitivity_type: "Delta",
      risk_factor: "USD-OIS",
      weight: 0.5,
      risk_value: {
        "3M": 1, "6M": 2, "1Y": 3, "2Y": 4, "3Y": 5,
        "5Y": 6, "10Y": 7, "15Y": 8, "20Y": 9, "30Y": 10,
      },
    };
    const pivotBody = {
      rows: [{ key: "sens:T-42", doc: pivotDoc }],
      total: 1,
      limit: 20,
      offset: 0,
      ms: 5,
    };

    async function openDrilldownAndGetPill() {
      mockCalcAndPivotResponses(baseResponse, pivotBody);
      render(<CalcPanel />);
      fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
      await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
      const usdRow = screen
        .getAllByTestId("bucket-row")
        .find((r) => r.getAttribute("data-bucket") === "USD-IRS")!;
      fireEvent.click(usdRow);
      const pill = await screen.findByTestId("drilldown-pill-trade");
      return pill as HTMLButtonElement;
    }

    it("clicking the trade_id pill opens the drawer with trade_id title and JSON body", async () => {
      const pill = await openDrilldownAndGetPill();
      expect(pill.tagName).toBe("BUTTON");
      expect(pill).toHaveAttribute("aria-label", "View JSON for trade T-42");
      fireEvent.click(pill);
      const drawer = await screen.findByTestId("trade-json-drawer");
      expect(drawer).toHaveAttribute("role", "dialog");
      expect(drawer).toHaveAttribute("aria-modal", "false");
      expect(drawer).toHaveAttribute("aria-label", "Trade T-42 JSON");
      expect(screen.getByTestId("trade-json-drawer-title").textContent).toBe("T-42");
      const body = screen.getByTestId("trade-json-drawer-body");
      expect(body.textContent).toBe(JSON.stringify(pivotDoc, null, 2));
    });

    it("pressing Escape closes the drawer", async () => {
      const pill = await openDrilldownAndGetPill();
      fireEvent.click(pill);
      const drawer = await screen.findByTestId("trade-json-drawer");
      fireEvent.keyDown(drawer, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("trade-json-drawer")).toBeNull());
    });

    it("Copy JSON button calls navigator.clipboard.writeText with the pretty-printed JSON", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });
      const pill = await openDrilldownAndGetPill();
      fireEvent.click(pill);
      await screen.findByTestId("trade-json-drawer");
      fireEvent.click(screen.getByTestId("trade-json-drawer-copy"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(pivotDoc, null, 2));
      // Transient "Copied" affordance.
      await waitFor(() =>
        expect(screen.getByTestId("trade-json-drawer-copy").textContent).toBe("Copied"),
      );
    });

    it("after closing, focus returns to the originating pill button", async () => {
      const pill = await openDrilldownAndGetPill();
      fireEvent.click(pill);
      const closeBtn = await screen.findByTestId("trade-json-drawer-close");
      expect(document.activeElement).toBe(closeBtn);
      fireEvent.click(closeBtn);
      await waitFor(() => expect(screen.queryByTestId("trade-json-drawer")).toBeNull());
      expect(document.activeElement).toBe(pill);
    });
  });
});
