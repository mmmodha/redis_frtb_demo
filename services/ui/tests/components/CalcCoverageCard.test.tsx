// Wave 6.39.D — CalcCoverageCard surfaces GET /admin/calc-coverage as a
// sortable + filterable table with a summary header. Skeleton during load,
// empty state when the coverage list is empty.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CalcCoverageCard } from "../../src/components/CalcCoverageCard";
import type { CalcCoverageResponse } from "../../src/lib/admin";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockOnce(body: CalcCoverageResponse | { error: string }, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
}

function sample(): CalcCoverageResponse {
  return {
    coverage: [
      { risk_class: "GIRR", bucket: "1", sens_type: "Delta", rollup_present: true, sens_doc_count: 42 },
      { risk_class: "GIRR", bucket: "2", sens_type: "Delta", rollup_present: false, sens_doc_count: 0 },
      { risk_class: "Equity", bucket: "9", sens_type: "Vega", rollup_present: true, sens_doc_count: 7 },
    ],
    summary: { total: 3, present: 2, missing: 1 },
  };
}

describe("<CalcCoverageCard />", () => {
  it("shows a loading skeleton while the first fetch is in flight", () => {
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch;
    render(<CalcCoverageCard />);
    expect(screen.getByTestId("calc-coverage-skeleton")).toBeInTheDocument();
  });

  it("renders summary + rows when the endpoint returns data", async () => {
    mockOnce(sample());
    render(<CalcCoverageCard />);
    const table = await screen.findByTestId("calc-coverage-table");
    const rows = within(table).getAllByRole("row");
    // 1 header row + 3 data rows
    expect(rows.length).toBe(4);
    const summary = screen.getByTestId("calc-coverage-summary");
    expect(summary).toHaveTextContent(/3/);
    expect(summary).toHaveTextContent(/present/i);
    expect(summary).toHaveTextContent(/missing/i);
  });

  it("renders an empty state when coverage is []", async () => {
    mockOnce({ coverage: [], summary: { total: 0, present: 0, missing: 0 } });
    render(<CalcCoverageCard />);
    const empty = await screen.findByTestId("calc-coverage-empty");
    expect(empty).toHaveTextContent(/no calc coverage yet/i);
  });

  it("renders an error message when the endpoint returns non-2xx", async () => {
    mockOnce({ error: "no active target" }, 503);
    render(<CalcCoverageCard />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/calc coverage/i);
  });

  it("filters rows by the search input (risk_class / bucket / sens_type)", async () => {
    mockOnce(sample());
    render(<CalcCoverageCard />);
    await screen.findByTestId("calc-coverage-table");
    const search = screen.getByTestId("calc-coverage-search");
    fireEvent.change(search, { target: { value: "Equity" } });
    await waitFor(() => {
      const tbody = screen.getByTestId("calc-coverage-table").querySelector("tbody");
      expect(tbody!.querySelectorAll("tr").length).toBe(1);
      expect(tbody!.textContent).toMatch(/Equity/);
    });
  });

  it("toggles sort by rollup_present when the header is clicked", async () => {
    mockOnce(sample());
    render(<CalcCoverageCard />);
    await screen.findByTestId("calc-coverage-table");
    fireEvent.click(screen.getByTestId("calc-coverage-sort-present"));
    const tbody = screen.getByTestId("calc-coverage-table").querySelector("tbody")!;
    const firstRowPresent = tbody.querySelectorAll("tr")[0]!.textContent;
    // After clicking once the missing rows (false) should come first.
    expect(firstRowPresent).toMatch(/missing/i);
  });
});
