import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import type { CalcSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

// Mirror of the helper in CalcPanel.bucket-subset.test.tsx — captures every
// outgoing /calc/sbm request body so the regime tests can assert the wire
// payload directly (no fragile string-matching on the URL).
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

function makeResponse(regime: "low" | "medium" | "high" = "medium"): CalcSbmResponse {
  return {
    charge: 9558.91465449378,
    per_bucket: [{ bucket: "USD", K_b: 200, S_b: 180, count: 5000, ms: 12 }],
    total_ms: 14,
    shard_breakdown: [{ shard: "shard-1", buckets: ["USD"], ms: 12 }],
    fanout_ms: 2,
    correlation_regime: regime,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Wave 5.31b — Correlation regime segmented control", () => {
  it("renders the segmented control with Medium selected by default", () => {
    render(<CalcPanel />);
    const group = screen.getByTestId("correlation-regime");
    const radiogroup = within(group).getByRole("radiogroup");
    expect(radiogroup).toHaveAttribute("aria-labelledby", "correlation-regime-label");
    const med = screen.getByTestId("regime-option-medium");
    expect(med).toHaveAttribute("aria-checked", "true");
    expect(med).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("regime-option-low")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("regime-option-high")).toHaveAttribute("aria-checked", "false");
  });

  it("does NOT send correlation_regime when the user leaves the default (regression safety)", async () => {
    const sent = mockCalcWithCapture(makeResponse("medium"));
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ risk_class: "GIRR", sensitivity_type: "Delta" });
    expect(sent[0]).not.toHaveProperty("correlation_regime");
  });

  it("clicking Low sends correlation_regime: 'low' and reflects the selection", async () => {
    const sent = mockCalcWithCapture(makeResponse("low"));
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("regime-option-low"));
    expect(screen.getByTestId("regime-option-low")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({ correlation_regime: "low" });
  });

  it("clicking High sends correlation_regime: 'high'", async () => {
    const sent = mockCalcWithCapture(makeResponse("high"));
    render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("regime-option-high"));
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({ correlation_regime: "high" });
  });

  it("ArrowRight from Medium → High and ArrowLeft wraps back to Low (radiogroup roving tabindex)", () => {
    render(<CalcPanel />);
    const med = screen.getByTestId("regime-option-medium");
    med.focus();
    fireEvent.keyDown(med, { key: "ArrowRight" });
    expect(screen.getByTestId("regime-option-high")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByTestId("regime-option-high"), { key: "ArrowRight" });
    // wraps to low
    expect(screen.getByTestId("regime-option-low")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByTestId("regime-option-low"), { key: "ArrowLeft" });
    // wraps back to high
    expect(screen.getByTestId("regime-option-high")).toHaveAttribute("aria-checked", "true");
  });

  it("Space and Enter activate the focused option", () => {
    render(<CalcPanel />);
    const low = screen.getByTestId("regime-option-low");
    low.focus();
    fireEvent.keyDown(low, { key: " " });
    expect(low).toHaveAttribute("aria-checked", "true");
    const high = screen.getByTestId("regime-option-high");
    high.focus();
    fireEvent.keyDown(high, { key: "Enter" });
    expect(high).toHaveAttribute("aria-checked", "true");
  });

  it("regime hint line updates with the active selection (factor visible to the user)", () => {
    render(<CalcPanel />);
    expect(screen.getByTestId("regime-hint").textContent).toMatch(/1\.0/);
    fireEvent.click(screen.getByTestId("regime-option-low"));
    expect(screen.getByTestId("regime-hint").textContent).toMatch(/0\.75/);
    fireEvent.click(screen.getByTestId("regime-option-high"));
    expect(screen.getByTestId("regime-hint").textContent).toMatch(/1\.25/);
  });

  it("RegimeBadge reflects the regime echoed by the api response, not just the picker", async () => {
    // api response advertises 'high' regardless of what the user picked —
    // the badge must trust the wire response so we don't lie about what was
    // actually applied to the charge.
    mockCalcWithCapture(makeResponse("high"));
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    const badge = await screen.findByTestId("regime-badge");
    expect(badge).toHaveAttribute("data-regime", "high");
    expect(badge.textContent).toMatch(/high/i);
  });

  it("RegimeBadge is omitted when the api response carries no correlation_regime field (legacy/back-compat)", async () => {
    const legacy: CalcSbmResponse = {
      charge: 100,
      per_bucket: [{ bucket: "USD", K_b: 10, S_b: 5, count: 1, ms: 1 }],
      total_ms: 1,
      shard_breakdown: [{ shard: "s1", buckets: ["USD"], ms: 1 }],
      fanout_ms: 1,
    };
    mockCalcWithCapture(legacy);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    expect(screen.queryByTestId("regime-badge")).toBeNull();
  });
});
