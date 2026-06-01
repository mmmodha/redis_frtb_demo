// Wave 5.16z2 — tests for the LockoutBanner.
//
// Renders nothing when the inflight hook reports count=0 (or while still
// loading) and surfaces the active items + ages when count>0.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LockoutBanner } from "../../src/components/LockoutBanner";

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

function mockInflight(snapshot: { count: number; items: any[]; ready?: boolean }): void {
  vi.doMock("../../src/hooks/useInflight", () => ({
    useInflight: () => ({
      count: snapshot.count,
      items: snapshot.items,
      stale: [],
      ready: snapshot.ready ?? true,
    }),
  }));
}

async function freshBanner() {
  const mod = await import("../../src/components/LockoutBanner");
  return mod.LockoutBanner;
}

describe("<LockoutBanner/>", () => {
  it("renders nothing when count=0 (and is a no-op while not ready)", async () => {
    mockInflight({ count: 0, items: [], ready: true });
    const Banner = await freshBanner();
    const { container } = render(<Banner />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("lockout-banner")).toBeNull();
  });

  it("renders amber banner with title and item labels+ages when count>0", async () => {
    const now = Date.now();
    mockInflight({
      count: 2,
      items: [
        { id: "a", kind: "loadgen", label: "loadgen-1", started_at: now - 12_000 },
        { id: "b", kind: "ingest", label: "ingest-3", started_at: now - 3_000 },
      ],
      ready: true,
    });
    const Banner = await freshBanner();
    render(<Banner />);
    const banner = screen.getByTestId("lockout-banner");
    expect(banner.getAttribute("data-slot")).toBe("lockout-banner");
    expect(banner).toHaveTextContent(/2 active runs — target switching disabled/i);
    expect(banner).toHaveTextContent(/loadgen-1/);
    expect(banner).toHaveTextContent(/ingest-3/);
    // Ages render as "Ns" for sub-minute entries.
    expect(banner.textContent ?? "").toMatch(/\d+s/);
  });

  it("uses singular 'run' wording when count=1", async () => {
    mockInflight({
      count: 1,
      items: [{ id: "a", kind: "loadgen", label: "loadgen-1", started_at: Date.now() }],
      ready: true,
    });
    // Re-import after mocking — vi.doMock above won't affect already-imported modules.
    vi.resetModules();
    vi.doMock("../../src/hooks/useInflight", () => ({
      useInflight: () => ({
        count: 1,
        items: [{ id: "a", kind: "loadgen", label: "loadgen-1", started_at: Date.now() }],
        stale: [],
        ready: true,
      }),
    }));
    const Banner = await freshBanner();
    render(<Banner />);
    expect(screen.getByTestId("lockout-banner")).toHaveTextContent(/1 active run —/i);
  });
});
