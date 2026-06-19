import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  EMPTY_FILTER_CHIPS_VALUE,
  FilterChips,
  type FilterChipsValue,
} from "../../src/components/FilterChips";

// Per-request URL-matched fetch stub. Backend response shapes mirror
// services/api/src/routes/facets.ts (Wave 6.41.A) and the /suggest route.
function setupFetch(handlers: Array<{ match: RegExp; body: unknown; status?: number }>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    for (const h of handlers) {
      if (h.match.test(url)) {
        return new Response(JSON.stringify(h.body), {
          status: h.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function Harness({
  initial = EMPTY_FILTER_CHIPS_VALUE,
  onChangeSpy,
}: { initial?: FilterChipsValue; onChangeSpy?: (v: FilterChipsValue) => void }) {
  const [v, setV] = useState<FilterChipsValue>(initial);
  return (
    <FilterChips
      value={v}
      onChange={(next) => {
        setV(next);
        onChangeSpy?.(next);
      }}
    />
  );
}

describe("<FilterChips />", () => {
  beforeEach(() => {
    setupFetch([
      {
        match: /\/facets\/desk/,
        body: {
          ok: true, ms: 1, target_label: "t", cached: false,
          desks: [
            { desk: "GIRR_LDN", count: 12 },
            { desk: "GIRR_NYC", count: 8 },
          ],
        },
      },
      {
        match: /\/facets\/region/,
        body: {
          ok: true, ms: 1, target_label: "t", cached: false,
          regions: [
            { region: "LDN", count: 20 },
            { region: "NYC", count: 5 },
          ],
        },
      },
      {
        match: /\/facets\/bucket/,
        body: {
          ok: true, ms: 1, target_label: "t", cached: false,
          buckets: [
            { risk_class: "GIRR", bucket: "1", count: 4 },
            { risk_class: "GIRR", bucket: "2", count: 3 },
            { risk_class: "FX", bucket: "1", count: 2 },
          ],
        },
      },
      {
        match: /\/suggest\?/,
        body: {
          suggestions: [
            { value: "EQ-LDN", score: 1 },
            { value: "EQ-NYC", score: 0.9 },
          ],
          ms: 1,
        },
      },
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the four chip triggers with ARIA roles and aria-expanded=false closed", () => {
    render(<Harness />);
    const group = screen.getByTestId("filter-chips");
    expect(group).toHaveAttribute("role", "group");
    for (const id of ["filter-chip-desk-trigger", "filter-chip-book-trigger", "filter-chip-region-trigger", "filter-chip-bucket-trigger"]) {
      const trigger = screen.getByTestId(id);
      expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("desk dropdown: loads /facets/desk on open and toggles include.desk on click", async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.click(screen.getByTestId("filter-chip-desk-trigger"));
    await waitFor(() => expect(screen.getByTestId("filter-chip-desk-popover")).toBeInTheDocument());
    const opts = await screen.findAllByTestId("filter-chips-option");
    expect(opts).toHaveLength(2);
    expect(opts[0]).toHaveAttribute("data-value", "GIRR_LDN");

    fireEvent.mouseDown(opts[0]!);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ desk: ["GIRR_LDN"] }));

    // re-click deselects
    fireEvent.mouseDown(screen.getAllByTestId("filter-chips-option")[0]!);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ desk: [] }));
  });

  it("region dropdown: loads /facets/region and updates include.region", async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.click(screen.getByTestId("filter-chip-region-trigger"));
    await waitFor(() => expect(screen.getByTestId("filter-chip-region-popover")).toBeInTheDocument());
    const opts = await screen.findAllByTestId("filter-chips-option");
    expect(opts.map((o) => o.getAttribute("data-value"))).toEqual(["LDN", "NYC"]);
    fireEvent.mouseDown(opts[1]!);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ region: ["NYC"] }));
  });

  it("bucket dropdown: groups by risk_class and commits NUMBERS to include.bucket", async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.click(screen.getByTestId("filter-chip-bucket-trigger"));
    await waitFor(() => expect(screen.getByTestId("filter-chip-bucket-popover")).toBeInTheDocument());
    // group headings reflect the risk_class field from /facets/bucket
    expect(screen.getByTestId("filter-chip-bucket-group-GIRR")).toBeInTheDocument();
    expect(screen.getByTestId("filter-chip-bucket-group-FX")).toBeInTheDocument();
    const opts = await screen.findAllByTestId("filter-chip-bucket-option");
    expect(opts).toHaveLength(3);
    expect(opts[0]).toHaveAttribute("data-bucket", "1");
    expect(opts[0]).toHaveAttribute("data-risk-class", "GIRR");
    fireEvent.mouseDown(opts[0]!);
    const last = spy.mock.calls.at(-1)![0] as FilterChipsValue;
    expect(last.bucket).toEqual([1]);
    expect(typeof last.bucket[0]).toBe("number");
  });

  it("book typeahead: typing ≥2 chars fires /suggest, click adds chip", async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.click(screen.getByTestId("filter-chip-book-trigger"));
    const input = await screen.findByTestId("filter-chip-book-input");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-autocomplete", "list");

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // 2 chars — fires after debounce
    fireEvent.change(input, { target: { value: "EQ" } });
    const opts = await screen.findAllByTestId("filter-chip-book-option");
    expect(opts.length).toBeGreaterThan(0);
    const suggestCall = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes("/suggest"));
    expect(suggestCall).toBeDefined();
    expect(String(suggestCall![0])).toContain("field=book");

    fireEvent.mouseDown(opts[0]!);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ book: ["EQ-LDN"] }));
  });

  it("popover trigger toggles aria-expanded and Escape closes it", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("filter-chip-desk-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByTestId("filter-chip-desk-popover")).toBeInTheDocument());
    // Esc on the listbox closes the popover
    const lb = await within(screen.getByTestId("filter-chip-desk-popover")).findByRole("listbox");
    fireEvent.keyDown(lb, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("filter-chip-desk-popover")).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("arrow keys move the active option and Enter toggles selection in the multiselect", async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.click(screen.getByTestId("filter-chip-desk-trigger"));
    const lb = await screen.findByRole("listbox", { name: /desks/i });
    fireEvent.keyDown(lb, { key: "ArrowDown" });
    fireEvent.keyDown(lb, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ desk: ["GIRR_LDN"] }));
  });

  it("clear button appears with a selection and resets that chip only", async () => {
    const spy = vi.fn();
    render(<Harness initial={{ desk: ["GIRR_LDN"], book: ["B"], region: [], bucket: [] }} onChangeSpy={spy} />);
    const clear = screen.getByTestId("filter-chip-desk-clear");
    fireEvent.click(clear);
    expect(spy).toHaveBeenLastCalledWith({ desk: [], book: ["B"], region: [], bucket: [] });
  });

  it("badges render selection counts", () => {
    render(<Harness initial={{ desk: ["a", "b"], book: ["c"], region: [], bucket: [1, 2, 3] }} />);
    expect(screen.getByTestId("filter-chip-desk-badge")).toHaveTextContent("2");
    expect(screen.getByTestId("filter-chip-book-badge")).toHaveTextContent("1");
    expect(screen.queryByTestId("filter-chip-region-badge")).toBeNull();
    expect(screen.getByTestId("filter-chip-bucket-badge")).toHaveTextContent("3");
  });

  it("renders an empty-state hint when /facets/desk returns no rows", async () => {
    vi.unstubAllGlobals();
    setupFetch([
      { match: /\/facets\/desk/, body: { ok: true, ms: 1, target_label: "t", cached: false, desks: [] } },
    ]);
    render(<Harness />);
    fireEvent.click(screen.getByTestId("filter-chip-desk-trigger"));
    await waitFor(() => expect(screen.getByText(/No desks indexed yet/i)).toBeInTheDocument());
  });
});
