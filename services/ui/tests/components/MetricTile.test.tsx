import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  // Wave 5.57 — tile is non-interactive without history and becomes a
  // button when history + onClick are provided.
  it("renders as a plain div when no history is supplied", () => {
    render(<MetricTile label="Total keys" value="1,234" />);
    expect(screen.queryByTestId("metric-tile-button")).toBeNull();
  });

  it("becomes a clickable button when history + onClick are provided", () => {
    const onClick = vi.fn();
    render(
      <MetricTile
        label="Total keys"
        value="1,234"
        history={{ points: [1, 2, 3, 4], ariaLabel: "tk history" }}
        onClick={onClick}
      />,
    );
    const btn = screen.getByTestId("metric-tile-button");
    expect(btn.tagName).toBe("BUTTON");
    expect(screen.getByTestId("sparkline")).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
