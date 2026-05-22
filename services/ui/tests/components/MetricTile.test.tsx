import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricTile } from "../../src/components/MetricTile";

describe("<MetricTile />", () => {
  it("displays the label, value and unit", () => {
    render(<MetricTile label="Total keys" value="1,234" unit="keys" />);
    expect(screen.getByText("Total keys")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("keys")).toBeInTheDocument();
  });

  it("renders a status badge when status prop is provided", () => {
    render(<MetricTile label="Memory" value="42" unit="MB" status="live" />);
    expect(screen.getByText(/live/i)).toBeInTheDocument();
  });
});
