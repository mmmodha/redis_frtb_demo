import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RateGauge } from "../../src/panels/RateGauge";

function defaults() {
  return {
    rps: 0,
    smoothedRps: 0,
    inFlight: 0,
    high_water: 0,
    throttled: false,
    headroomPct: 1,
    recent429Count: 0,
    label: "Ingest (bulk-loader → redis)",
    // The integration site always passes an explicit testId; pin it here so
    // the per-element testids match what the IngestPanel asserts on.
    testId: "rate-gauge-ingest",
  };
}

describe("RateGauge", () => {
  it("renders rps headline + region accessibility", () => {
    // 1_500 rps  ⇒  "1.5K/s" (the one-decimal K/M formatter for values
    // under 10K). Avoids float-rounding edge cases at the .05 boundary.
    render(<RateGauge {...defaults()} smoothedRps={1_500} />);
    const region = screen.getByRole("region", { name: /ingest rate/i });
    expect(region).toBeInTheDocument();
    expect(screen.getByTestId("rate-gauge-ingest-rate")).toHaveTextContent("1.5K/s");
  });

  it("renders no throttle chip when both throttled=false and recent_429=0 (idle)", () => {
    render(<RateGauge {...defaults()} smoothedRps={1234} headroomPct={1} />);
    expect(screen.queryByTestId("rate-gauge-ingest-chip")).toBeNull();
  });

  it("renders the red THROTTLED chip when throttled=true", () => {
    render(<RateGauge {...defaults()} throttled={true} recent429Count={15} headroomPct={0.1} />);
    const chip = screen.getByTestId("rate-gauge-ingest-chip");
    expect(chip).toHaveAttribute("data-state", "throttled");
    expect(chip).toHaveAttribute("role", "status");
    expect(chip).toHaveTextContent(/THROTTLED · 15 429\/10s/);
    expect(chip.className).toContain("pill--err");
  });

  it("renders the amber recovering chip when throttled=false but recent_429>0", () => {
    render(<RateGauge {...defaults()} throttled={false} recent429Count={5} headroomPct={0.6} />);
    const chip = screen.getByTestId("rate-gauge-ingest-chip");
    expect(chip).toHaveAttribute("data-state", "recovering");
    expect(chip).toHaveTextContent(/recovering · 5 429\/10s/);
    expect(chip.className).toContain("pill--warn");
  });

  it("capacity bar fill math: in_flight=4000 / high_water=8000 → 50% with green tone", () => {
    render(<RateGauge {...defaults()} inFlight={4000} high_water={8000} headroomPct={0.5} />);
    const fill = screen.getByTestId("rate-gauge-ingest-capacity-fill");
    expect(fill.style.width).toBe("50%");
    expect(fill.getAttribute("data-tone")).toBe("ok");
  });

  it("capacity bar clamps to 100% with red tone when in_flight > high_water (1.5x)", () => {
    render(<RateGauge {...defaults()} inFlight={12_000} high_water={8000} headroomPct={0} />);
    const fill = screen.getByTestId("rate-gauge-ingest-capacity-fill");
    expect(fill.style.width).toBe("100%");
    expect(fill.getAttribute("data-tone")).toBe("err");
  });

  it("capacity bar handles 0/0 edge case → 0% width, no NaN, ok tone (headroom=1)", () => {
    render(<RateGauge {...defaults()} inFlight={0} high_water={0} headroomPct={1} />);
    const fill = screen.getByTestId("rate-gauge-ingest-capacity-fill");
    expect(fill.style.width).toBe("0%");
    expect(fill.getAttribute("data-tone")).toBe("ok");
    expect(screen.getByTestId("rate-gauge-ingest-in-flight")).toHaveTextContent(/in-flight 0 \/ 0/);
  });

  it("amber capacity tone fires when headroom_pct is in [0.2, 0.5)", () => {
    render(<RateGauge {...defaults()} inFlight={6000} high_water={8000} headroomPct={0.25} />);
    const fill = screen.getByTestId("rate-gauge-ingest-capacity-fill");
    expect(fill.getAttribute("data-tone")).toBe("warn");
  });
});
