// RED — LoadgenPanel: start/stop controls + live latency display.
//
// The panel calls lib/loadgen for start/stop/status and subscribes to live
// metrics via subscribeMetrics. We stub the module so the test never opens a
// real EventSource and never touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

let lastOnFrame: ((f: unknown) => void) | null = null;
const startMock = vi.fn(async (_req: unknown) => ({
  running: true,
  config: { concurrency: 200, duration_sec: 60, mix: { pivot: 0.5, calc: 0.5 } },
}));
const stopMock = vi.fn(async () => ({ stopped: true }));
const statusMock = vi.fn(async () => ({ running: false }));
const subscribeMock = vi.fn((cb: (f: unknown) => void) => {
  lastOnFrame = cb;
  return () => { lastOnFrame = null; };
});

vi.mock("../../src/lib/loadgen", () => ({
  startLoadgen: (req: unknown) => startMock(req as never),
  stopLoadgen: () => stopMock(),
  getLoadgenStatus: () => statusMock(),
  subscribeMetrics: (cb: (f: unknown) => void) => subscribeMock(cb),
}));

import { LoadgenPanel } from "../../src/panels/LoadgenPanel";

beforeEach(() => {
  startMock.mockClear();
  stopMock.mockClear();
  statusMock.mockClear();
  subscribeMock.mockClear();
  lastOnFrame = null;
});

function frame(over: Partial<Record<string, unknown>> = {}) {
  return {
    ts: Date.now(),
    throughput_rps: 0,
    latency: { p50: 0, p95: 0, p99: 0 },
    errors: 0,
    total_requests: 0,
    per_endpoint: {
      pivot: { count: 0, errors: 0, p50: 0, p95: 0, p99: 0 },
      calc: { count: 0, errors: 0, p50: 0, p95: 0, p99: 0 },
    },
    running: true,
    elapsed_sec: 0,
    ...over,
  };
}

describe("<LoadgenPanel />", () => {
  it("renders a 'Concurrent Load' heading and a Start button", () => {
    render(<LoadgenPanel />);
    expect(screen.getByRole("heading", { name: /concurrent load/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();
  });

  it("renders a concurrency input defaulted to 200 (per spec)", () => {
    render(<LoadgenPanel />);
    const input = screen.getByLabelText(/concurrency/i) as HTMLInputElement;
    expect(input.value).toBe("200");
  });

  it("clicking Start calls startLoadgen with the chosen concurrency + 50/50 mix", async () => {
    render(<LoadgenPanel />);
    fireEvent.change(screen.getByLabelText(/concurrency/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    const arg = startMock.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(arg.concurrency).toBe(50);
    expect(arg.mix).toEqual({ pivot: 0.5, calc: 0.5 });
  });

  it("after Start, a Stop button appears and clicking it calls stopLoadgen", async () => {
    render(<LoadgenPanel />);
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    const stopBtn = await screen.findByRole("button", { name: /stop/i });
    fireEvent.click(stopBtn);
    await waitFor(() => expect(stopMock).toHaveBeenCalledTimes(1));
  });

  it("renders incoming SSE frames as p50/p95/p99 + throughput tiles", async () => {
    render(<LoadgenPanel />);
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled());
    act(() => {
      lastOnFrame!(frame({
        throughput_rps: 1234,
        latency: { p50: 12, p95: 88, p99: 245 },
        total_requests: 5000,
      }));
    });
    expect(await screen.findByText("245")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("shows the 200-user / p99 <500ms acceptance pill (LOCKED text)", () => {
    render(<LoadgenPanel />);
    expect(screen.getByText(/200 concurrent users/i)).toBeInTheDocument();
    expect(screen.getByText(/p99 ?< ?500/i)).toBeInTheDocument();
  });
});
