import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  try { window.localStorage.setItem("frtb:calc:view:v1", "advanced"); } catch { /* ignore */ }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mock(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as typeof fetch;
}

async function clickCalculate() {
  render(<CalcPanel />);
  fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
}

describe("<CalcPanel /> friendly empty-target banner (Wave 5.16z3)", () => {
  it("412 bootstrap response renders the amber banner with target_label + bootstrap_phase, not the red alert", async () => {
    mock(412, {
      error: "Unknown Index name",
      target_label: "test2",
      bootstrap_phase: "indexing",
    });
    await clickCalculate();
    const banner = await waitFor(() => screen.getByTestId("empty-target-banner"));
    expect(banner.getAttribute("data-kind")).toBe("bootstrap");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.className).toMatch(/panel-callout--amber/);
    expect(banner.textContent).toMatch(/Bootstrapping/i);
    expect(banner.textContent).toMatch(/test2/);
    expect(banner.textContent).toMatch(/indexing/);
    // Real-error path is suppressed.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("503 no-data-or-index response renders the amber banner with risk_class + measure + hint", async () => {
    mock(503, {
      error: "no-data-or-index",
      risk_class: "GIRR",
      measure: "Delta",
      hint: "Use the Sources tab to upload sensitivities.",
    });
    await clickCalculate();
    const banner = await waitFor(() => screen.getByTestId("empty-target-banner"));
    expect(banner.getAttribute("data-kind")).toBe("no-data");
    expect(banner.className).toMatch(/panel-callout--amber/);
    expect(banner.textContent).toMatch(/GIRR/);
    expect(banner.textContent).toMatch(/Delta/);
    expect(banner.textContent).toMatch(/Use the Sources tab to upload sensitivities/);
    expect(banner.textContent).toMatch(/Sources tab to ingest/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("unexpected 500 still renders the existing red alert (not swallowed)", async () => {
    mock(500, { error: "internal boom" });
    await clickCalculate();
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toMatch(/internal boom/);
    expect(screen.queryByTestId("empty-target-banner")).toBeNull();
  });
});
