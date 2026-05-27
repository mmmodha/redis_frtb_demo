// Wave 4.6 — RED tests for <ShardMetricsStrip />, the UI tile-grid that
// powers the "200 concurrent analysts" demo moment. Each tile shows one
// primary shard's live ops/sec, slot count, and used memory; the strip
// subscribes to /observability/shards/stream (SSE) for sub-second updates.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ShardMetricsStrip } from "../../src/components/ShardMetricsStrip";

interface FakeMessageEvent { data: string }

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: FakeMessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  emit(payload: unknown): void {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
  error(): void {
    if (this.onerror) this.onerror(new Event("error"));
  }
  close(): void {
    this.closed = true;
  }
}

const originalES = globalThis.EventSource;

afterEach(() => {
  FakeEventSource.instances = [];
  if (originalES === undefined) {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  } else {
    (globalThis as { EventSource: unknown }).EventSource = originalES;
  }
  vi.restoreAllMocks();
});

function installFakeEventSource(): typeof FakeEventSource {
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource as unknown;
  return FakeEventSource;
}

describe("<ShardMetricsStrip />", () => {
  it("opens an EventSource at /observability/shards/stream on mount", () => {
    installFakeEventSource();
    render(<ShardMetricsStrip />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toMatch(/\/observability\/shards\/stream$/);
  });

  it("renders one tile per primary shard once the first SSE frame arrives", async () => {
    installFakeEventSource();
    render(<ShardMetricsStrip />);
    await act(async () => {
      FakeEventSource.instances[0]!.emit([
        { shardId: "a1a1a1a1", role: "master", opsPerSec: 1200, slotCount: 5461, usedMemoryBytes: 524288, netInBytes: 10, netOutBytes: 20 },
        { shardId: "b2b2b2b2", role: "master", opsPerSec:  980, slotCount: 5462, usedMemoryBytes: 524288, netInBytes: 11, netOutBytes: 21 },
        { shardId: "c3c3c3c3", role: "master", opsPerSec:  860, slotCount: 5461, usedMemoryBytes: 524288, netInBytes: 12, netOutBytes: 22 },
      ]);
    });
    const tiles = screen.getAllByTestId("shard-tile");
    expect(tiles).toHaveLength(3);
    expect(screen.getByText("a1a1a1a1")).toBeInTheDocument();
    expect(screen.getByText("b2b2b2b2")).toBeInTheDocument();
    expect(screen.getByText("c3c3c3c3")).toBeInTheDocument();
  });

  it("shows ops/sec, slot count and used memory on each tile", async () => {
    installFakeEventSource();
    render(<ShardMetricsStrip />);
    await act(async () => {
      FakeEventSource.instances[0]!.emit([
        { shardId: "a1a1a1a1", role: "master", opsPerSec: 1234, slotCount: 5461, usedMemoryBytes: 1048576, netInBytes: 0, netOutBytes: 0 },
      ]);
    });
    expect(screen.getByText(/1,234/)).toBeInTheDocument();        // ops/sec
    expect(screen.getByText(/5,461/)).toBeInTheDocument();        // slot count
    expect(screen.getByText(/1\.00\s*MB/i)).toBeInTheDocument();  // 1 MiB human
  });

  it("live-updates tile values when subsequent SSE frames arrive", async () => {
    installFakeEventSource();
    render(<ShardMetricsStrip />);
    await act(async () => {
      FakeEventSource.instances[0]!.emit([
        { shardId: "a1a1a1a1", role: "master", opsPerSec: 100, slotCount: 16384, usedMemoryBytes: 1024, netInBytes: 0, netOutBytes: 0 },
      ]);
    });
    expect(screen.getByText("100")).toBeInTheDocument();
    await act(async () => {
      FakeEventSource.instances[0]!.emit([
        { shardId: "a1a1a1a1", role: "master", opsPerSec: 9999, slotCount: 16384, usedMemoryBytes: 2048, netInBytes: 0, netOutBytes: 0 },
      ]);
    });
    expect(screen.getByText(/9,999/)).toBeInTheDocument();
    expect(screen.queryByText("100")).not.toBeInTheDocument();
  });

  it("closes the EventSource on unmount", async () => {
    installFakeEventSource();
    const { unmount } = render(<ShardMetricsStrip />);
    unmount();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});
