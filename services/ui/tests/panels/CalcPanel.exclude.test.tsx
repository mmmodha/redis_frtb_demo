import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import { renderCalcPanel } from "../helpers/renderCalcPanel";
import type { CalcSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

// Mirrors the helpers in CalcPanel.bucket-subset.test.tsx / .regime.test.tsx —
// captures the body of every outbound fetch so the test can assert the wire
// shape directly.
function mockCalcWithCapture(body: CalcSbmResponse) {
  const sent: Array<unknown> = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return sent;
}

const baseResponse: CalcSbmResponse = {
  charge: 1234,
  per_bucket: [{ bucket: "USD", K_b: 200, S_b: 180, count: 5000, ms: 12 }],
  total_ms: 14,
  shard_breakdown: [{ shard: "shard-1", buckets: ["USD"], ms: 12 }],
  fanout_ms: 2,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    // best-effort — jsdom localStorage should always be available
  }
});

describe("Advanced disclosure — row-exclusion combos (book / trade_id / risk_factor)", () => {
  it("renders the Advanced disclosure collapsed by default with a plain 'Show advanced…' summary", () => {
    renderCalcPanel();
    const details = screen.getByTestId("advanced-filters") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(false);
    expect(screen.getByTestId("advanced-filters-summary").textContent).toBe("Show advanced…");
  });

  it("shows three exclude combos (book / trade_id / risk_factor) when expanded", () => {
    renderCalcPanel();
    const details = screen.getByTestId("advanced-filters") as HTMLDetailsElement;
    details.open = true;
    expect(screen.getByTestId("exclude-book")).toBeInTheDocument();
    expect(screen.getByTestId("exclude-trade_id")).toBeInTheDocument();
    expect(screen.getByTestId("exclude-risk_factor")).toBeInTheDocument();
  });

  it("Calculate with no exclude touched sends NO `exclude` field (byte-identical default-path body)", async () => {
    const sent = mockCalcWithCapture(baseResponse);
    renderCalcPanel();
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ risk_class: "GIRR", sensitivity_type: "Delta" });
    expect(sent[0]).not.toHaveProperty("exclude");
  });

  it("adding a book chip and clicking Calculate sends exclude.book in the request body", async () => {
    const sent = mockCalcWithCapture(baseResponse);
    renderCalcPanel();
    (screen.getByTestId("advanced-filters") as HTMLDetailsElement).open = true;
    const bookInput = screen.getByLabelText(/^Books to exclude$/i);
    fireEvent.change(bookInput, { target: { value: "BookA" } });
    fireEvent.keyDown(bookInput, { key: "Enter" });
    await waitFor(() => {
      const chips = within(screen.getByTestId("exclude-book-chips")).getAllByTestId("exclude-chip");
      expect(chips.map((c) => c.getAttribute("data-value"))).toEqual(["BookA"]);
    });
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({ exclude: { book: ["BookA"] } });
  });

  it("comma-separated typing commits multiple chips at once (CSV paste path)", async () => {
    mockCalcWithCapture(baseResponse);
    renderCalcPanel();
    (screen.getByTestId("advanced-filters") as HTMLDetailsElement).open = true;
    const tradeInput = screen.getByLabelText(/^Trades to exclude$/i);
    fireEvent.change(tradeInput, { target: { value: "T1,T2,T3," } });
    await waitFor(() => {
      const chips = within(screen.getByTestId("exclude-trade_id-chips")).getAllByTestId("exclude-chip");
      expect(chips.map((c) => c.getAttribute("data-value"))).toEqual(["T1", "T2", "T3"]);
    });
  });

  it("clicking × on a chip removes it from the exclude set", async () => {
    mockCalcWithCapture(baseResponse);
    renderCalcPanel();
    (screen.getByTestId("advanced-filters") as HTMLDetailsElement).open = true;
    const factorInput = screen.getByLabelText(/^Risk factors to exclude$/i);
    fireEvent.change(factorInput, { target: { value: "RF1,RF2," } });
    await waitFor(() => {
      const chips = within(screen.getByTestId("exclude-risk_factor-chips")).getAllByTestId("exclude-chip");
      expect(chips).toHaveLength(2);
    });
    const remove = screen.getByRole("button", { name: /Remove RF1/ });
    fireEvent.click(remove);
    await waitFor(() => {
      const chips = within(screen.getByTestId("exclude-risk_factor-chips")).getAllByTestId("exclude-chip");
      expect(chips).toHaveLength(1);
      expect(chips[0]!.getAttribute("data-value")).toBe("RF2");
    });
  });

  it("Exclude-rows section heading shows the running excluded count when chips are present", async () => {
    mockCalcWithCapture(baseResponse);
    renderCalcPanel();
    (screen.getByTestId("advanced-filters") as HTMLDetailsElement).open = true;
    fireEvent.change(screen.getByLabelText(/^Books to exclude$/i), { target: { value: "A,B," } });
    fireEvent.change(screen.getByLabelText(/^Trades to exclude$/i), { target: { value: "T1," } });
    await waitFor(() => {
      expect(screen.getByTestId("exclude-rows-heading").textContent).toBe(
        "Exclude rows · 3 excluded",
      );
    });
    // Summary itself stays "Show advanced…" — the count surfaces in the section header.
    expect(screen.getByTestId("advanced-filters-summary").textContent).toBe("Show advanced…");
  });
});
