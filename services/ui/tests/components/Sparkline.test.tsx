import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sparkline } from "../../src/components/Sparkline";

describe("<Sparkline />", () => {
  it("renders 10 path points for a 10-tenor risk_value object", () => {
    const tenors = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    render(<Sparkline points={tenors} labels={["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"]} />);
    const svg = screen.getByTestId("sparkline");
    expect(svg).toBeInTheDocument();
    const circles = svg.querySelectorAll("circle[data-point-index]");
    expect(circles.length).toBe(10);
    // Path is L-separated for the line; with 10 points we expect M then 9 L commands.
    const pathA = svg.querySelector('path[data-series-id="a"]') as SVGPathElement | null;
    expect(pathA).not.toBeNull();
    const d = pathA!.getAttribute("d") ?? "";
    expect(d.startsWith("M")).toBe(true);
    expect((d.match(/L/g) ?? []).length).toBe(9);
  });

  it("renders two series for Curvature cvr_up/cvr_down arrays", () => {
    const up = [0.1, 0.2, 0.3, 0.4, 0.5];
    const down = [-0.05, -0.1, -0.15, -0.2, -0.25];
    render(<Sparkline points={up} pointsB={down} series={2} />);
    const svg = screen.getByTestId("sparkline");
    expect(svg.getAttribute("data-series")).toBe("2");
    expect(svg.querySelector('path[data-series-id="a"]')).not.toBeNull();
    expect(svg.querySelector('path[data-series-id="b"]')).not.toBeNull();
  });

  // Wave 5.57 — area-filled tile variant with last-point marker only.
  it("renders an area path and a single last-point marker when filled+dots=last", () => {
    render(<Sparkline points={[1, 2, 3, 4]} filled dots="last" />);
    const svg = screen.getByTestId("sparkline");
    expect(svg.getAttribute("data-filled")).toBe("1");
    expect(svg.getAttribute("data-dots")).toBe("last");
    expect(svg.querySelector('path[data-series-id="a-area"]')).not.toBeNull();
    const markers = svg.querySelectorAll("circle[data-point-index]");
    expect(markers.length).toBe(1);
    expect(markers[0]!.getAttribute("data-point-last")).toBe("1");
  });

  it("renders the empty placeholder when points is []", () => {
    render(<Sparkline points={[]} filled dots="last" ariaLabel="empty hist" />);
    expect(screen.getByLabelText("empty hist")).toBeInTheDocument();
  });
});
