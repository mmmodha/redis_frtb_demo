import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import { renderCalcPanel } from "../helpers/renderCalcPanel";
import type { CalcSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

function makeResponse(total_ms: number): CalcSbmResponse {
  return {
    charge: 100,
    per_bucket: [{ bucket: "USD-IRS", K_b: 10, S_b: 8, count: 100, ms: total_ms }],
    total_ms,
    shard_breakdown: [{ shard: "shard-1", buckets: ["USD-IRS"], ms: total_ms }],
    fanout_ms: total_ms,
  };
}

function mockResponse(total_ms: number) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(makeResponse(total_ms)), {
      headers: { "content-type": "application/json" },
    }),
  ) as typeof fetch;
}

async function runCalc(total_ms: number) {
  mockResponse(total_ms);
  renderCalcPanel();
  fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
  await waitFor(() => expect(screen.getByTestId("wallclock-badge")).toBeInTheDocument());
  return screen.getByTestId("wallclock-badge");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("<CalcPanel /> wall-clock badge", () => {
  it("is green when total_ms < 2000 (MVP gate)", async () => {
    const badge = await runCalc(1500);
    expect(badge.getAttribute("data-tone")).toBe("green");
    expect(badge.textContent).toMatch(/1500/);
  });

  it("is amber when total_ms is between 2000 and 4999", async () => {
    const badge = await runCalc(3200);
    expect(badge.getAttribute("data-tone")).toBe("amber");
  });

  it("is red when total_ms >= 5000", async () => {
    const badge = await runCalc(7100);
    expect(badge.getAttribute("data-tone")).toBe("red");
  });
});

describe("<CalcPanel /> error handling", () => {
  it("renders an error message and re-enables the button on api failure", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "calc failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;
    renderCalcPanel();
    const button = screen.getByRole("button", { name: /calculate sbm risk charge/i });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/error|failed/i),
    );
    expect(button).not.toBeDisabled();
  });
});
