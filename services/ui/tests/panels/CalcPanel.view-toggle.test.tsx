import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";

// Wave 6.45.B — Simple|Advanced pill toggle. Defaults to Simple on first
// load, persists the choice in localStorage (frtb:calc:view:v1) so a refresh
// restores it, and SHOULD NOT render the pre-6.45.B body when Simple is
// active (no DOM, no calc requests).

const originalFetch = globalThis.fetch;

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* ignore */ }
  globalThis.fetch = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try { window.localStorage.clear(); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe("CalcPanel Simple|Advanced toggle", () => {
  it("renders the toggle with both buttons", () => {
    render(<CalcPanel />);
    const toggle = screen.getByTestId("calc-view-toggle");
    expect(toggle).toBeInTheDocument();
    expect(screen.getByTestId("calc-view-toggle-simple")).toBeInTheDocument();
    expect(screen.getByTestId("calc-view-toggle-advanced")).toBeInTheDocument();
  });

  it("defaults to Simple on first load (no localStorage)", () => {
    render(<CalcPanel />);
    expect(screen.getByTestId("simple-calc-view")).toBeInTheDocument();
    // Pre-6.45.B body must not be in the DOM under Simple.
    expect(screen.queryByTestId("advanced-filters")).toBeNull();
    expect(screen.queryByTestId("calc-cta")).toBeNull();
  });

  it("clicking Advanced reveals the pre-6.45.B body and hides the Simple view", () => {
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-view-toggle-advanced"));
    expect(screen.queryByTestId("simple-calc-view")).toBeNull();
    expect(screen.getByTestId("advanced-filters")).toBeInTheDocument();
    expect(screen.getByTestId("calc-cta")).toBeInTheDocument();
  });

  it("clicking Simple after Advanced hides the pre-6.45.B body again", () => {
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-view-toggle-advanced"));
    fireEvent.click(screen.getByTestId("calc-view-toggle-simple"));
    expect(screen.getByTestId("simple-calc-view")).toBeInTheDocument();
    expect(screen.queryByTestId("advanced-filters")).toBeNull();
  });

  it("persists the choice in localStorage and restores it on remount", () => {
    const { unmount } = render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-view-toggle-advanced"));
    expect(window.localStorage.getItem("frtb:calc:view:v1")).toBe("advanced");
    unmount();
    render(<CalcPanel />);
    expect(screen.getByTestId("advanced-filters")).toBeInTheDocument();
    expect(screen.queryByTestId("simple-calc-view")).toBeNull();
  });

  it("fires no /calc/sbm requests while Simple is active (Simple owns its own request flow)", () => {
    render(<CalcPanel />);
    const calcSbmCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.endsWith("/calc/sbm") || u.endsWith("/calc/sbm/by-desk") || u.endsWith("/calc/sbm/total"));
    expect(calcSbmCalls.length).toBe(0);
  });
});
