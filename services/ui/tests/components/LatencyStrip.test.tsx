import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LatencyStrip } from "../../src/components/LatencyStrip";

describe("<LatencyStrip />", () => {
  it("renders the empty-state baseline text when no samples are present", () => {
    render(<LatencyStrip server={[]} client={[]} />);
    const strip = screen.getByTestId("latency-strip");
    expect(strip).toHaveAttribute("data-empty", "true");
    expect(strip).toHaveTextContent(/Run a search to start collecting samples\./);
  });

  it("renders 100 bar groups when given 100 samples for both series", () => {
    const series = Array.from({ length: 100 }, (_, i) => 10 + (i % 7));
    const { container } = render(<LatencyStrip server={series} client={series} />);
    const groups = container.querySelectorAll(".latency-strip__bar-group");
    expect(groups.length).toBe(100);
    const strip = screen.getByTestId("latency-strip");
    expect(strip).toHaveAttribute("data-empty", "false");
    // Headline reports the sample count.
    expect(screen.getByTestId("latency-strip-headline")).toHaveTextContent(/n = 100/);
  });

  it("applies the amber class to the p99 element when computed p99 >= 100 ms", () => {
    // Force p99 >= 100: fill the array with values >= 100.
    const slow = Array.from({ length: 100 }, () => 150);
    const { container } = render(<LatencyStrip server={slow} client={slow} />);
    const amberHeadline = container.querySelector(".latency-strip__p99--amber");
    expect(amberHeadline).not.toBeNull();
    const amberRefline = container.querySelector(".latency-strip__refline--amber");
    expect(amberRefline).not.toBeNull();
    // And the green variant is absent.
    expect(container.querySelector(".latency-strip__refline--green")).toBeNull();
  });

  it("applies the green class to the p99 element when computed p99 < 100 ms", () => {
    const fast = Array.from({ length: 50 }, () => 12);
    const { container } = render(<LatencyStrip server={fast} client={fast} />);
    expect(container.querySelector(".latency-strip__p99--green")).not.toBeNull();
    expect(container.querySelector(".latency-strip__refline--green")).not.toBeNull();
    expect(container.querySelector(".latency-strip__refline--amber")).toBeNull();
  });

  it("exposes an SVG with an aria-label that includes the sample count", () => {
    render(<LatencyStrip server={[1, 2, 3]} client={[1, 2, 3]} />);
    const svg = screen.getByRole("img", { name: /3 samples/i });
    expect(svg).toBeInTheDocument();
  });
});
