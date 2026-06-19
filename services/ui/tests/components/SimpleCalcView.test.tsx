import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SimpleCalcView } from "../../src/components/SimpleCalcView";

// Wave 6.45.B — SimpleCalcView unit coverage. The view drives /facets/desk
// and /facets/region on mount, then maps dropdown state onto runSimpleCalc
// (POSTs /calc/sbm or /calc/sbm/by-desk). Error responses surface as the
// friendly retry banner; raw text never leaks.

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockApi(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.body) {
      try { calls.push({ url, body: JSON.parse(String(init.body)) }); } catch { calls.push({ url }); }
    } else {
      calls.push({ url });
    }
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

const facetsResponse = (url: string): Response | null => {
  if (url.endsWith("/facets/desk")) {
    return new Response(JSON.stringify({ ok: true, desks: [
      { desk: "RATES_LDN", count: 100 }, { desk: "FX_NYC", count: 80 },
    ] }), { headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/facets/region")) {
    return new Response(JSON.stringify({ ok: true, regions: [
      { region: "EMEA", count: 50 }, { region: "AMER", count: 60 },
    ] }), { headers: { "content-type": "application/json" } });
  }
  return null;
};

describe("SimpleCalcView", () => {
  it("populates the Filter dropdown from /facets/desk + /facets/region", async () => {
    mockApi((url) => facetsResponse(url) ?? new Response("{}"));
    render(<SimpleCalcView />);
    const filter = await screen.findByTestId("simple-calc-filter");
    await waitFor(() => {
      const opts = within(filter as HTMLElement).getAllByRole("option");
      const labels = opts.map((o) => o.textContent);
      expect(labels[0]).toMatch(/All/);
      expect(labels).toContain("Desk: RATES_LDN");
      expect(labels).toContain("Region: EMEA");
    });
  });

  it("Group-by dropdown lists None / Desk / Book / Region", () => {
    mockApi((url) => facetsResponse(url) ?? new Response("{}"));
    render(<SimpleCalcView />);
    const group = screen.getByTestId("simple-calc-groupby") as HTMLSelectElement;
    const labels = within(group).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["None", "Desk", "Book", "Region"]);
  });

  it("All + None → POSTs /calc/sbm with no include and renders the total summary", async () => {
    const calls = mockApi((url, init) => {
      const f = facetsResponse(url); if (f) return f;
      if (url.endsWith("/calc/sbm")) {
        return new Response(JSON.stringify({
          charge: 1234.5,
          per_bucket: [{ bucket: "USD-IRS", K_b: 100, S_b: 80, count: 1000, ms: 12 }],
          total_ms: 14, shard_breakdown: [], fanout_ms: 14,
        }), { headers: { "content-type": "application/json" } });
      }
      void init; return new Response("{}", { status: 404 });
    });
    render(<SimpleCalcView />);
    await screen.findByTestId("simple-calc-filter");
    fireEvent.click(screen.getByTestId("simple-calc-cta"));
    await waitFor(() => expect(screen.getByTestId("simple-calc-summary")).toBeInTheDocument());
    const calcCall = calls.find((c) => c.url.endsWith("/calc/sbm"));
    expect(calcCall).toBeTruthy();
    expect((calcCall!.body as { include?: unknown }).include).toBeUndefined();
  });

  it("Desk filter + Desk group → /calc/sbm/by-desk with desk include + sortable table", async () => {
    const calls = mockApi((url) => {
      const f = facetsResponse(url); if (f) return f;
      if (url.endsWith("/calc/sbm/by-desk")) {
        return new Response(JSON.stringify({
          desks: [
            { desk: "RATES_LDN", K_b: 200, count: 100 },
            { desk: "FX_NYC", K_b: 50, count: 40 },
          ], total_K_b: 300, ms: 18, cached: false,
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    render(<SimpleCalcView />);
    await screen.findByTestId("simple-calc-filter");
    fireEvent.change(screen.getByTestId("simple-calc-filter"), { target: { value: "desk:RATES_LDN" } });
    fireEvent.change(screen.getByTestId("simple-calc-groupby"), { target: { value: "desk" } });
    fireEvent.click(screen.getByTestId("simple-calc-cta"));
    await waitFor(() => expect(screen.getByTestId("simple-calc-table")).toBeInTheDocument());
    const byDesk = calls.find((c) => c.url.endsWith("/calc/sbm/by-desk"));
    expect((byDesk!.body as { include?: { desk?: string[] } }).include?.desk).toEqual(["RATES_LDN"]);
    const rows = screen.getAllByTestId("simple-calc-row");
    expect(rows[0]?.getAttribute("data-label")).toBe("RATES_LDN");
    fireEvent.click(within(screen.getByTestId("simple-calc-table")).getAllByRole("columnheader")[0]!);
    const sortedRows = screen.getAllByTestId("simple-calc-row");
    expect(sortedRows[0]?.getAttribute("data-label")).toBe("FX_NYC");
  });

  it("422 unsupported_combination → friendly banner, raw text not displayed", async () => {
    mockApi((url) => {
      const f = facetsResponse(url); if (f) return f;
      if (url.endsWith("/calc/sbm")) {
        return new Response(JSON.stringify({
          error: "unsupported-combination",
          error_code: "unsupported_combination",
          hint: "internal APPLY+0 detail not for users",
          target_label: "local",
        }), { status: 422, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    render(<SimpleCalcView />);
    await screen.findByTestId("simple-calc-filter");
    fireEvent.click(screen.getByTestId("simple-calc-cta"));
    const banner = await screen.findByTestId("simple-calc-error");
    expect(banner.textContent).toMatch(/Couldn't compute that combination/);
    expect(banner.textContent).not.toMatch(/APPLY\+0/);
    expect(screen.getByTestId("simple-calc-retry")).toBeInTheDocument();
  });

  it("Book group → friendly error banner (no /facets/book endpoint exists)", async () => {
    mockApi((url) => facetsResponse(url) ?? new Response("{}"));
    render(<SimpleCalcView />);
    await screen.findByTestId("simple-calc-filter");
    fireEvent.change(screen.getByTestId("simple-calc-groupby"), { target: { value: "book" } });
    fireEvent.click(screen.getByTestId("simple-calc-cta"));
    await screen.findByTestId("simple-calc-error");
  });
});
