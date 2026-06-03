import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";

// Calc-side fuzzy toggle. Mirrors PivotPanel's toggle behaviour onto the
// three exclude comboboxes (book / trade_id / risk_factor). The toggle
// lives inside the "Show advanced…" disclosure so it travels with the
// combos it affects.

const originalFetch = globalThis.fetch;

function suggestFetchMock() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({ suggestions: [{ value: "RATES-LDN", score: 1 }], ms: 0.5 }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = suggestFetchMock();
  try {
    window.localStorage.clear();
  } catch {
    // best-effort
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("CalcPanel fuzzy-suggestions toggle (in Advanced)", () => {
  it("renders a fuzzy toggle with default state 'on'", () => {
    render(<CalcPanel />);
    const toggle = screen.getByTestId("calc-fuzzy-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("calc-fuzzy-hint")).toHaveTextContent(/fuzzy suggestions:\s*on/i);
  });

  it("flipping the toggle off ⇒ typing in Books to exclude does NOT open the listbox", async () => {
    render(<CalcPanel />);
    const toggle = screen.getByTestId("calc-fuzzy-toggle");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    // Flipping off also forces the disclosure open so the toggle stays discoverable.
    const details = screen.getByTestId("advanced-filters") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    const bookInput = screen.getByLabelText(/^Books to exclude$/i) as HTMLInputElement;
    fireEvent.focus(bookInput);
    fireEvent.change(bookInput, { target: { value: "RA" } });
    // Wait past any debounce window — no listbox, no fetch.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(bookInput).toHaveAttribute("aria-expanded", "false");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("flipping the toggle back on ⇒ listbox opens on next keystroke", async () => {
    render(<CalcPanel />);
    const toggle = screen.getByTestId("calc-fuzzy-toggle");
    // Off first
    fireEvent.click(toggle);
    const bookInput = screen.getByLabelText(/^Books to exclude$/i) as HTMLInputElement;
    fireEvent.change(bookInput, { target: { value: "RA" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("listbox")).toBeNull();
    // Flip back on, type one more letter.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(bookInput, { target: { value: "RAT" } });
    await screen.findByRole("listbox");
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const url = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toContain("/suggest?");
    expect(url).toContain("fuzzy=1");
  });

  it("disclosure stays collapsed by default (pristine state with fuzzy on, no chips)", () => {
    render(<CalcPanel />);
    const details = screen.getByTestId("advanced-filters") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });
});
