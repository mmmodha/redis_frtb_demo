// Wave 6.43.B.4 — tests for the in-flight SwitchBanner.
//
// Drives polling lifecycle: appears on first trigger, polls /switch-status
// every 500ms, renders one row per service with a phase pill + spinner for
// non-terminal rows, and auto-hides 2s after every service reaches a
// terminal phase (committed / push_failed / drain_timeout). Polling stops
// once the banner hides.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const getSwitchStatusMock = vi.fn();
vi.mock("../../src/lib/connections", () => ({
  getSwitchStatus: () => getSwitchStatusMock(),
}));

async function loadBanner() {
  const mod = await import("../../src/components/SwitchBanner");
  return mod.SwitchBanner;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  getSwitchStatusMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<SwitchBanner/>", () => {
  it("does not render until triggerId becomes non-zero", async () => {
    const Banner = await loadBanner();
    const { container } = render(<Banner triggerId={0} />);
    expect(container.firstChild).toBeNull();
    expect(getSwitchStatusMock).not.toHaveBeenCalled();
  });

  it("polls every 500ms, renders 3 service rows, auto-hides 2s after all terminal", async () => {
    // Sequence: initial (all pending) → drained → committed.
    getSwitchStatusMock
      .mockResolvedValueOnce({
        current_switch_id: "sw-abcd1234",
        phase: "draining",
        per_service: [
          { name: "ingest", phase: "pending" },
          { name: "source", phase: "pending" },
          { name: "loadgen", phase: "pending" },
        ],
      })
      .mockResolvedValueOnce({
        current_switch_id: "sw-abcd1234",
        phase: "draining",
        per_service: [
          { name: "ingest", phase: "drained" },
          { name: "source", phase: "drained" },
          { name: "loadgen", phase: "drained" },
        ],
      })
      .mockResolvedValue({
        current_switch_id: "sw-abcd1234",
        phase: "committed",
        per_service: [
          { name: "ingest", phase: "committed" },
          { name: "source", phase: "committed" },
          { name: "loadgen", phase: "committed" },
        ],
      });

    const Banner = await loadBanner();
    render(<Banner triggerId={1} targetLabel="prod-cluster" />);

    // First tick fires immediately on mount.
    await flushMicrotasks();
    expect(getSwitchStatusMock).toHaveBeenCalledTimes(1);

    const banner = screen.getByTestId("switch-banner");
    expect(banner).toHaveTextContent(/prod-cluster/);
    expect(banner).toHaveTextContent(/#1234/);
    expect(screen.getByTestId("switch-banner-row-ingest")).toHaveAttribute("data-phase", "pending");
    expect(screen.getByTestId("switch-banner-row-source")).toHaveAttribute("data-phase", "pending");
    expect(screen.getByTestId("switch-banner-row-loadgen")).toHaveAttribute("data-phase", "pending");

    // Second tick 500ms later.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getSwitchStatusMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("switch-banner-row-ingest")).toHaveAttribute("data-phase", "drained");

    // Third tick — all committed → polling stops, hide timer scheduled.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getSwitchStatusMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("switch-banner-row-ingest")).toHaveAttribute("data-phase", "committed");

    // Polling should now be stopped — further timer ticks add no calls.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getSwitchStatusMock).toHaveBeenCalledTimes(3);

    // Still visible during the 2s hide delay.
    expect(screen.queryByTestId("switch-banner")).not.toBeNull();

    // After 2s from terminal it auto-hides.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.queryByTestId("switch-banner")).toBeNull();
  });

  it("treats push_failed / drain_timeout as terminal", async () => {
    getSwitchStatusMock.mockResolvedValue({
      current_switch_id: "sw-xyz9",
      phase: "draining",
      per_service: [
        { name: "ingest", phase: "committed" },
        { name: "source", phase: "push_failed", error: "boom" },
        { name: "loadgen", phase: "drain_timeout" },
      ],
    });

    const Banner = await loadBanner();
    render(<Banner triggerId={1} />);
    await flushMicrotasks();
    expect(screen.getByTestId("switch-banner")).toHaveTextContent(/push_failed/);

    // All terminal on first tick → no further polls + auto-hides after 2s.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(getSwitchStatusMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("switch-banner")).toBeNull();
  });

  it("hides immediately when switch-status polling errors", async () => {
    getSwitchStatusMock.mockRejectedValue(new Error("unauthorized"));
    const Banner = await loadBanner();
    render(<Banner triggerId={1} targetLabel="prod-cluster" />);
    await flushMicrotasks();
    // scheduleHide runs on error — banner clears after 2s hide delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.queryByTestId("switch-banner")).toBeNull();
  });

  it("safety cap forces hide after 12s even if api never goes terminal", async () => {
    getSwitchStatusMock.mockResolvedValue({
      current_switch_id: "sw-stuck",
      phase: "draining",
      per_service: [
        { name: "ingest", phase: "draining" },
        { name: "source", phase: "draining" },
        { name: "loadgen", phase: "draining" },
      ],
    });
    const Banner = await loadBanner();
    render(<Banner triggerId={1} />);
    await flushMicrotasks();
    expect(screen.getByTestId("switch-banner")).toBeTruthy();
    // Run past the 12s safety cap plus the 2s hide delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.queryByTestId("switch-banner")).toBeNull();
  });
});
