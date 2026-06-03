import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MetricHistoryModal } from "../../src/components/MetricHistoryModal";

const POINTS = [
  { t: Date.now() - 60_000, v: 10 },
  { t: Date.now() - 30_000, v: 20 },
  { t: Date.now(), v: 15 },
];

describe("<MetricHistoryModal />", () => {
  it("returns null when closed", () => {
    const { container } = render(
      <MetricHistoryModal
        open={false}
        onClose={() => undefined}
        title="Total keys"
        points={POINTS}
        source="redis-timeseries"
        reason={null}
        windowMs={18_000_000}
        targetLabel="testcluster"
      />,
    );
    expect(container.querySelector("[data-testid='metric-history-modal']")).toBeNull();
  });

  it("renders chart, axis labels, and TimeSeries source label", () => {
    render(
      <MetricHistoryModal
        open
        onClose={() => undefined}
        title="Total keys"
        unit="keys"
        points={POINTS}
        source="redis-timeseries"
        reason={null}
        windowMs={18_000_000}
        targetLabel="testcluster"
      />,
    );
    expect(screen.getByTestId("metric-history-modal-chart")).toBeInTheDocument();
    // X-tick labels at 0, -1h, -2h, -3h, -4h, -5h.
    const ticks = screen.getAllByTestId("mhm-x-tick");
    expect(ticks.length).toBe(6);
    expect(ticks[0]!.textContent).toBe("now");
    expect(ticks[5]!.textContent).toBe("-5h");
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/Redis TimeSeries/);
    expect(screen.getByTestId("mhm-badge-min").textContent).toMatch(/min/);
    expect(screen.getByTestId("mhm-badge-max").textContent).toMatch(/max/);
    expect(screen.getByTestId("mhm-badge-avg").textContent).toMatch(/avg/);
  });

  it("calls onClose when the X button is pressed", () => {
    const onClose = vi.fn();
    render(
      <MetricHistoryModal open onClose={onClose} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t" />,
    );
    fireEvent.click(screen.getByTestId("metric-history-modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <MetricHistoryModal open onClose={onClose} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t" />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the backdrop but not the modal body", () => {
    const onClose = vi.fn();
    render(
      <MetricHistoryModal open onClose={onClose} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t" />,
    );
    const backdrop = screen.getByTestId("metric-history-modal");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Clicking the inner dialog should NOT close.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback source label when source is ring-buffer", () => {
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="ring-buffer" reason="module-not-loaded" windowMs={18_000_000} targetLabel="t" />,
    );
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/this browser/);
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/module not loaded/i);
  });

  it("renders an empty-state message when there are no points", () => {
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={[]}
        source="redis-timeseries" reason="no-data-yet" windowMs={18_000_000} targetLabel="t" />,
    );
    expect(screen.getByText(/Recording/i)).toBeInTheDocument();
  });
});
