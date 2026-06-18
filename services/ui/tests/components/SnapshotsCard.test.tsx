// Wave 6.39.D — SnapshotsCard surfaces GET /admin/snapshots as a list of
// snapshot runs with timestamps + key counts. Polls every 30 seconds.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { SnapshotsCard } from "../../src/components/SnapshotsCard";
import type { SnapshotsResponse } from "../../src/lib/admin";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeFetchQueue(bodies: Array<SnapshotsResponse>) {
  let i = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input.toString());
    const body = bodies[Math.min(i++, bodies.length - 1)]!;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

describe("<SnapshotsCard />", () => {
  it("renders snapshot rows with key counts", async () => {
    makeFetchQueue([{ snapshots: [
      { ts: "2026-06-18T01:00:00Z", key_count: 1200 },
      { ts: "2026-06-18T00:00:00Z", key_count: 800 },
    ] }]);
    render(<SnapshotsCard />);
    const list = await screen.findByTestId("snapshots-list");
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toMatch(/1,200/);
  });

  it("renders empty state when no snapshots", async () => {
    makeFetchQueue([{ snapshots: [] }]);
    render(<SnapshotsCard />);
    const empty = await screen.findByTestId("snapshots-empty");
    expect(empty).toHaveTextContent(/no snapshots yet/i);
  });

  it("polls every 30 seconds", async () => {
    const { calls } = makeFetchQueue([
      { snapshots: [] }, { snapshots: [] }, { snapshots: [] },
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SnapshotsCard />);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    const initial = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() => expect(calls.length).toBeGreaterThan(initial));
    expect(calls[0]).toMatch(/\/admin\/snapshots$/);
  });
});
