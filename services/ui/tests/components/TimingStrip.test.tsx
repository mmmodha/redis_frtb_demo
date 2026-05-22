import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimingStrip } from "../../src/components/TimingStrip";

describe("<TimingStrip />", () => {
  it("renders one bar per shard with label and ms", () => {
    render(
      <TimingStrip
        shards={[
          { id: "shard-1", label: "shard-1", ms: 12 },
          { id: "shard-2", label: "shard-2", ms: 8 },
        ]}
      />,
    );
    expect(screen.getByText("shard-1")).toBeInTheDocument();
    expect(screen.getByText("shard-2")).toBeInTheDocument();
    expect(screen.getByText(/12 ms/)).toBeInTheDocument();
    expect(screen.getByText(/8 ms/)).toBeInTheDocument();
  });

  it("renders an empty-state message when no shards are provided", () => {
    render(<TimingStrip shards={[]} />);
    expect(screen.getByText(/no shard timings/i)).toBeInTheDocument();
  });
});
