// Wave 6.39.D — BackfillStatusCard surfaces GET /admin/backfill-status.
// The endpoint is a "reserved stub" in 6.39.B so the card has to gracefully
// render a "not yet implemented" banner without looking broken, while still
// being prepared to show the real progress bar once the backend lights up.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BackfillStatusCard } from "../../src/components/BackfillStatusCard";
import type { BackfillStatusResponse } from "../../src/lib/admin";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockOnce(body: BackfillStatusResponse | { error: string }, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
}

describe("<BackfillStatusCard />", () => {
  it("renders the reserved-stub banner when status='not-implemented'", async () => {
    mockOnce({ total: 0, completed: 0, in_flight: 0, failed: 0, eta_ms: 0, status: "not-implemented" });
    render(<BackfillStatusCard />);
    const banner = await screen.findByTestId("backfill-stub-banner");
    expect(banner.textContent).toMatch(/not yet implemented|reserved/i);
  });

  it("renders a progress summary when status='running'", async () => {
    mockOnce({ total: 200, completed: 50, in_flight: 5, failed: 1, eta_ms: 30_000, status: "running" });
    render(<BackfillStatusCard />);
    const progress = await screen.findByTestId("backfill-progress");
    expect(progress).toHaveTextContent(/50/);
    expect(progress).toHaveTextContent(/200/);
    const bar = screen.getByTestId("backfill-progress-bar");
    // 50/200 = 25%
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
  });

  it("renders an error message when the endpoint fails", async () => {
    mockOnce({ error: "boom" }, 500);
    render(<BackfillStatusCard />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/backfill/i);
  });
});
