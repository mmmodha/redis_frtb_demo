import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { CalcRunProvider, resetCalcRunInFlightForTests, useCalcRun } from "../../src/context/CalcRunContext";
import { clearCalcRunStorage } from "../../src/lib/calcRunState";

function Probe() {
  const { startPerClassCalc, perClassLoading, perClass } = useCalcRun();
  return (
    <div>
      <button
        type="button"
        data-testid="start"
        onClick={() => startPerClassCalc(
          { risk_class: "GIRR", sensitivity_type: "Delta" },
          { riskClass: "GIRR", sensitivityType: "Delta" },
        )}
      >
        start
      </button>
      <span data-testid="loading">{String(perClassLoading)}</span>
      <span data-testid="status">{perClass.status}</span>
    </div>
  );
}

const baseResponse = {
  charge: 42,
  per_bucket: [{ bucket: "USD-IRS", K_b: 1, S_b: 1, count: 1, ms: 1 }],
  total_ms: 100,
  shard_breakdown: [],
  fanout_ms: 50,
};

describe("CalcRunContext", () => {
  beforeEach(() => {
    clearCalcRunStorage();
    resetCalcRunInFlightForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCalcRunStorage();
  });

  it("keeps per-class calc running across provider remount (navigation)", async () => {
    let resolveCalc: () => void = () => {};
    const gate = new Promise<void>((r) => { resolveCalc = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/facets")) {
        return { ok: true, json: async () => ({ ok: true, total_rows: 1, risk_class: { GIRR: 1 }, sensitivity_type: { Delta: 1 } }) };
      }
      if (url.includes("/calc/sbm") && !url.includes("total")) {
        await gate;
        return { ok: true, json: async () => baseResponse };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    }));

    const { unmount } = render(
      <CalcRunProvider>
        <Probe />
      </CalcRunProvider>,
    );

    fireEvent.click(screen.getByTestId("start"));
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("true"));

    unmount();

    render(
      <CalcRunProvider>
        <Probe />
      </CalcRunProvider>,
    );

    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    expect(screen.getByTestId("status")).toHaveTextContent("running");

    resolveCalc();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("done"));
  });
});
