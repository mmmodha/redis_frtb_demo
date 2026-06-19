import { describe, it, expect, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CalcByDesk } from "../../src/components/CalcByDesk";
import type { CalcSbmByDeskResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

function mockByDeskResponse(body: CalcSbmByDeskResponse | { error: string }, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as typeof fetch;
}

function deferredByDeskResponse(body: CalcSbmByDeskResponse) {
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

const populatedResponse: CalcSbmByDeskResponse = {
  ok: true,
  ms: 12.5,
  total_K_b: 600,
  cached: false,
  desks: [
    { desk: "RatesUS", K_b: 300, contribution_pct: 50.0, count: 1200 },
    { desk: "RatesEU", K_b: 200, contribution_pct: 33.3, count: 800 },
    { desk: "RatesJP", K_b: 100, contribution_pct: 16.7, count: 400 },
  ],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("<CalcByDesk />", () => {
  it("renders a loading skeleton while the request is in flight", async () => {
    const release = deferredByDeskResponse(populatedResponse);
    render(<CalcByDesk riskClass="GIRR" sensitivityType="Delta" />);
    await waitFor(() =>
      expect(screen.getByTestId("calc-by-desk-skeleton")).toBeInTheDocument(),
    );
    release();
    await waitFor(() =>
      expect(screen.queryByTestId("calc-by-desk-skeleton")).not.toBeInTheDocument(),
    );
  });

  it("renders top-N desks ranked by K_b once the response lands", async () => {
    mockByDeskResponse(populatedResponse);
    render(<CalcByDesk riskClass="GIRR" sensitivityType="Delta" />);
    await waitFor(() =>
      expect(screen.getByTestId("calc-by-desk-chart")).toBeInTheDocument(),
    );
    const rows = screen.getAllByTestId("calc-by-desk-row");
    expect(rows.map((r) => r.getAttribute("data-desk"))).toEqual([
      "RatesUS",
      "RatesEU",
      "RatesJP",
    ]);
    expect(screen.getByText("50.0% · 1200 sens")).toBeInTheDocument();
  });

  it("renders the empty state when zero desks are returned", async () => {
    mockByDeskResponse({
      ok: true,
      ms: 5,
      total_K_b: 0,
      cached: false,
      desks: [],
    });
    render(<CalcByDesk riskClass="GIRR" sensitivityType="Delta" />);
    await waitFor(() =>
      expect(screen.getByTestId("calc-by-desk-empty")).toBeInTheDocument(),
    );
    expect(screen.getByText(/no desk data yet/i)).toBeInTheDocument();
  });

  it("renders an error banner when the api call rejects", async () => {
    mockByDeskResponse({ error: "boom" }, 500);
    render(<CalcByDesk riskClass="GIRR" sensitivityType="Delta" />);
    await waitFor(() =>
      expect(screen.getByTestId("calc-by-desk-error")).toBeInTheDocument(),
    );
  });

  it("rows are non-interactive when no onDeskClick is provided", async () => {
    mockByDeskResponse(populatedResponse);
    render(<CalcByDesk riskClass="GIRR" sensitivityType="Delta" />);
    await waitFor(() =>
      expect(screen.getByTestId("calc-by-desk-chart")).toBeInTheDocument(),
    );
    const rows = screen.getAllByTestId("calc-by-desk-row");
    for (const r of rows) {
      expect(r.getAttribute("data-interactive")).toBe("false");
      expect(r.getAttribute("role")).toBe("listitem");
    }
    expect(screen.queryByRole("button", { name: /add desk/i })).toBeNull();
  });

  it("invokes onDeskClick with the desk name when an interactive row is clicked", async () => {
    mockByDeskResponse(populatedResponse);
    const onDeskClick = vi.fn();
    render(
      <CalcByDesk
        riskClass="GIRR"
        sensitivityType="Delta"
        onDeskClick={onDeskClick}
      />,
    );
    const firstRow = await screen.findByRole("button", { name: /add desk RatesUS/i });
    expect(firstRow.getAttribute("data-interactive")).toBe("true");
    fireEvent.click(firstRow);
    expect(onDeskClick).toHaveBeenCalledWith("RatesUS");
    fireEvent.keyDown(firstRow, { key: "Enter" });
    expect(onDeskClick).toHaveBeenCalledTimes(2);
  });

  it("posts the configured filters in the request body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(populatedResponse), {
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    render(
      <CalcByDesk
        riskClass="Equity"
        sensitivityType="Vega"
        correlationRegime="high"
        topN={5}
        exclude={{ book: ["BK1"] }}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      risk_class: "Equity",
      sensitivity_type: "Vega",
      correlation_regime: "high",
      top_n: 5,
      exclude: { book: ["BK1"] },
    });
  });
});
