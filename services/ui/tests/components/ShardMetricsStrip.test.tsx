// Wave 5.51 — <ShardMetricsStrip /> is now a pure presentational component:
// the parent Observability page owns the polling loop and passes shards in
// as a prop. These tests cover the prop-driven render contract; the
// previous EventSource-mock tests are replaced by Observability.live.test.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ShardMetricsStrip, type Shard } from "../../src/components/ShardMetricsStrip";

const SHARDS: Shard[] = [
  { shardId: "a1a1a1a1", role: "master", opsPerSec: 1200, slotCount: 5461, usedMemoryBytes: 524288, netInBytes: 10, netOutBytes: 20 },
  { shardId: "b2b2b2b2", role: "master", opsPerSec:  980, slotCount: 5462, usedMemoryBytes: 524288, netInBytes: 11, netOutBytes: 21 },
  { shardId: "c3c3c3c3", role: "master", opsPerSec:  860, slotCount: 5461, usedMemoryBytes: 524288, netInBytes: 12, netOutBytes: 22 },
];

describe("<ShardMetricsStrip />", () => {
  it("renders one tile per shard from props", () => {
    render(<ShardMetricsStrip shards={SHARDS} />);
    expect(screen.getAllByTestId("shard-tile")).toHaveLength(3);
    expect(screen.getByText("a1a1a1a1")).toBeInTheDocument();
    expect(screen.getByText("b2b2b2b2")).toBeInTheDocument();
    expect(screen.getByText("c3c3c3c3")).toBeInTheDocument();
  });

  it("shows ops/sec, slot count and used memory on each tile", () => {
    render(<ShardMetricsStrip shards={[
      { shardId: "a1a1a1a1", role: "master", opsPerSec: 1234, slotCount: 5461, usedMemoryBytes: 1048576, netInBytes: 0, netOutBytes: 0 },
    ]} />);
    expect(screen.getByText(/1,234/)).toBeInTheDocument();        // ops/sec
    expect(screen.getByText(/5,461/)).toBeInTheDocument();        // slot count
    expect(screen.getByText(/1\.00\s*MB/i)).toBeInTheDocument();  // 1 MiB human
  });

  it("renders nothing in the grid when shards is empty", () => {
    render(<ShardMetricsStrip shards={[]} />);
    expect(screen.queryAllByTestId("shard-tile")).toHaveLength(0);
    expect(screen.getByTestId("shard-metrics-strip")).toBeInTheDocument();
  });

  it("re-renders tile values when shards prop changes", () => {
    const { rerender } = render(<ShardMetricsStrip shards={[
      { shardId: "a1a1a1a1", role: "master", opsPerSec: 100, slotCount: 16384, usedMemoryBytes: 1024, netInBytes: 0, netOutBytes: 0 },
    ]} />);
    expect(screen.getByText("100")).toBeInTheDocument();
    rerender(<ShardMetricsStrip shards={[
      { shardId: "a1a1a1a1", role: "master", opsPerSec: 9999, slotCount: 16384, usedMemoryBytes: 2048, netInBytes: 0, netOutBytes: 0 },
    ]} />);
    expect(screen.getByText(/9,999/)).toBeInTheDocument();
    expect(screen.queryByText("100")).not.toBeInTheDocument();
  });
});
