// Wave 6.39.D — StreamStatusCard surfaces GET /admin/stream-status (xlen /
// maxlen / peak / retention). Polls every 5 seconds because stream depth is
// the most volatile signal in the admin set.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StreamStatusCard } from "../../src/components/StreamStatusCard";
import type { StreamStatusResponse } from "../../src/lib/admin";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeFetchQueue(bodies: Array<StreamStatusResponse>) {
  let i = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input.toString());
    const body = bodies[Math.min(i++, bodies.length - 1)]!;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

const SAMPLE: StreamStatusResponse = {
  stream_key: "sensitivities:in",
  xlen: 1_500,
  maxlen: 2_000_000,
  peak_rate_per_sec: 250,
  retention_hours_now: 5.5,
  retention_hours_at_cap: 96.25,
};

describe("<StreamStatusCard />", () => {
  it("renders xlen / maxlen / retention metrics", async () => {
    makeFetchQueue([SAMPLE]);
    render(<StreamStatusCard />);
    const metrics = await screen.findByTestId("stream-status-metrics");
    expect(metrics).toHaveTextContent(/1,500/);
    expect(metrics).toHaveTextContent(/2,000,000/);
    expect(metrics).toHaveTextContent(/5\.5/);
    expect(metrics).toHaveTextContent(/250/);
    expect(screen.getByText(/sensitivities:in/)).toBeInTheDocument();
  });

  it("renders an error message on non-2xx", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })) as typeof fetch;
    render(<StreamStatusCard />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/stream/i);
  });

  it("polls every 5 seconds", async () => {
    const { calls } = makeFetchQueue([SAMPLE, SAMPLE, SAMPLE]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<StreamStatusCard />);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    const initial = calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(calls.length).toBeGreaterThan(initial));
    expect(calls[0]).toMatch(/\/admin\/stream-status$/);
  });
});
