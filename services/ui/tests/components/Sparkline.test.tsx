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
});
