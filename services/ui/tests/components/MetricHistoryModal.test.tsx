import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, createEvent, within } from "@testing-library/react";
import { MetricHistoryModal } from "../../src/components/MetricHistoryModal";

// jsdom's PointerEvent constructor drops clientX/clientY from its init dict,
// so we round-trip through createEvent + defineProperty to attach the
// coordinates the brush handler relies on.
type PEv = "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel";
function firePointer(el: Element, type: PEv, clientX: number, pointerId = 1): void {
  const ev = createEvent[type](el, { pointerId, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clientX", { value: clientX, configurable: true });
  Object.defineProperty(ev, "clientY", { value: 100, configurable: true });
  fireEvent(el, ev);
}

const POINTS = [
  { t: Date.now() - 60_000, v: 10 },
  { t: Date.now() - 30_000, v: 20 },
  { t: Date.now(), v: 15 },
];

// Stub `getBoundingClientRect` so clientX → SVG-x math in the brush handler is
// deterministic in jsdom (which otherwise returns a zero-size rect).
const CHART_W = 760;
const CHART_H = 280;
const origGBCR = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, left: 0, top: 0, right: CHART_W, bottom: CHART_H,
      width: CHART_W, height: CHART_H, toJSON: () => ({}),
    } as DOMRect;
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origGBCR;
});

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

  // Wave 5.61 — window-selector pills.
  it("renders the four window pills with 5h active by default", () => {
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t" />,
    );
    const group = screen.getByTestId("mhm-window-selector");
    expect(group).toHaveAttribute("role", "radiogroup");
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["30m", "1h", "2h", "5h"]);
    expect(screen.getByTestId("mhm-window-pill-5h")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mhm-window-pill-30m")).toHaveAttribute("aria-checked", "false");
  });

  it("default active pill matches the initial windowMs prop", () => {
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={3_600_000} targetLabel="t" />,
    );
    expect(screen.getByTestId("mhm-window-pill-1h")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mhm-window-pill-5h")).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a pill fires onWindowChange with the right windowMs", () => {
    const onWindowChange = vi.fn();
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t"
        onWindowChange={onWindowChange} />,
    );
    fireEvent.click(screen.getByTestId("mhm-window-pill-30m"));
    expect(onWindowChange).toHaveBeenCalledTimes(1);
    expect(onWindowChange).toHaveBeenCalledWith(1_800_000);
  });

  it("does not fire onWindowChange when clicking the already-active pill", () => {
    const onWindowChange = vi.fn();
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t"
        onWindowChange={onWindowChange} />,
    );
    fireEvent.click(screen.getByTestId("mhm-window-pill-5h"));
    expect(onWindowChange).not.toHaveBeenCalled();
  });

  it("X-axis ticks adapt to the selected window (30m)", () => {
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t" />,
    );
    const ticks = screen.getAllByTestId("mhm-x-tick");
    expect(ticks.length).toBe(7);
    expect(ticks[0]!.textContent).toBe("now");
    expect(ticks.map((t) => t.textContent)).toContain("-30m");
    expect(ticks.map((t) => t.textContent)).toContain("-5m");
  });

  it("source footer label adapts to the selected window", () => {
    const { rerender } = render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t" />,
    );
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/last 5h/);
    rerender(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t" />,
    );
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/last 30m/);
  });

  it("ArrowRight on a pill moves selection to the next pill", () => {
    const onWindowChange = vi.fn();
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t"
        onWindowChange={onWindowChange} />,
    );
    const fivePill = screen.getByTestId("mhm-window-pill-5h");
    fireEvent.keyDown(fivePill, { key: "ArrowRight" });
    expect(onWindowChange).toHaveBeenLastCalledWith(1_800_000);
    expect(screen.getByTestId("mhm-window-pill-30m")).toHaveAttribute("aria-checked", "true");
  });

  it("ArrowLeft on a pill cycles to the previous pill", () => {
    const onWindowChange = vi.fn();
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t"
        onWindowChange={onWindowChange} />,
    );
    const pill = screen.getByTestId("mhm-window-pill-30m");
    fireEvent.keyDown(pill, { key: "ArrowLeft" });
    expect(onWindowChange).toHaveBeenLastCalledWith(18_000_000);
  });

  it("Enter on a focused pill activates that selection", () => {
    const onWindowChange = vi.fn();
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t"
        onWindowChange={onWindowChange} />,
    );
    const pill = screen.getByTestId("mhm-window-pill-2h");
    fireEvent.keyDown(pill, { key: "Enter" });
    expect(onWindowChange).toHaveBeenCalledWith(7_200_000);
  });

  it("close button is borderless and still labelled 'Close'", () => {
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={POINTS}
        source="redis-timeseries" reason={null} windowMs={18_000_000} targetLabel="t" />,
    );
    const close = screen.getByTestId("metric-history-modal-close");
    expect(close).toHaveAttribute("aria-label", "Close");
    expect(close.querySelector(".metric-history-modal__close-glyph")).not.toBeNull();
  });

  // Wave 5.63 — brush-to-zoom.
  // Build a 5-point dataset evenly spread across the middle 90% of the
  // window so micro-second clock drift between `Date.now()` here and the
  // next render does not push the boundary points outside the visible range.
  const buildSpreadPoints = (windowMs: number): Array<{ t: number; v: number }> => {
    const now = Date.now();
    const base = now - windowMs;
    const off = windowMs * 0.05;
    const span = windowMs * 0.9;
    return [
      { t: base + off + 0,           v: 10 },
      { t: base + off + span * 0.25, v: 20 },
      { t: base + off + span * 0.5,  v: 30 },
      { t: base + off + span * 0.75, v: 40 },
      { t: base + off + span,        v: 50 },
    ];
  };

  it("drag from x=200 to x=400 zooms, narrowing the path and stats", () => {
    const windowMs = 1_800_000;
    const pts = buildSpreadPoints(windowMs);
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={pts}
        source="redis-timeseries" reason={null} windowMs={windowMs} targetLabel="t" />,
    );
    expect(screen.getByTestId("mhm-badge-min").textContent).toMatch(/10/);
    expect(screen.getByTestId("mhm-badge-max").textContent).toMatch(/50/);

    const svg = screen.getByTestId("metric-history-modal-chart");
    firePointer(svg, "pointerDown", 200);
    firePointer(svg, "pointerMove", 400);
    firePointer(svg, "pointerUp", 400);

    // Stats now reflect points whose t falls inside ~[base+0.21·win, base+0.5·win]:
    // that's the v=20 and v=30 samples.
    expect(screen.getByTestId("mhm-badge-min").textContent).toMatch(/20/);
    expect(screen.getByTestId("mhm-badge-max").textContent).toMatch(/30/);
    expect(screen.getByTestId("mhm-reset-zoom")).toBeInTheDocument();
    expect(screen.getByTestId("mhm-zoom-label")).toBeInTheDocument();
    expect(screen.getByTestId("metric-history-modal-source").textContent).toMatch(/zoomed/);
  });

  it("a short drag (< 6px) does not apply a zoom", () => {
    const pts = buildSpreadPoints(1_800_000);
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={pts}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t" />,
    );
    const svg = screen.getByTestId("metric-history-modal-chart");
    firePointer(svg, "pointerDown", 200);
    firePointer(svg, "pointerMove", 203);
    firePointer(svg, "pointerUp", 203);
    expect(screen.queryByTestId("mhm-reset-zoom")).toBeNull();
    expect(screen.getByTestId("mhm-badge-min").textContent).toMatch(/10/);
    expect(screen.getByTestId("mhm-badge-max").textContent).toMatch(/50/);
  });

  it("Reset zoom restores the full-window view", () => {
    const pts = buildSpreadPoints(1_800_000);
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={pts}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t" />,
    );
    const svg = screen.getByTestId("metric-history-modal-chart");
    firePointer(svg, "pointerDown", 200);
    firePointer(svg, "pointerMove", 400);
    firePointer(svg, "pointerUp", 400);
    expect(screen.getByTestId("mhm-reset-zoom")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mhm-reset-zoom"));
    expect(screen.queryByTestId("mhm-reset-zoom")).toBeNull();
    expect(screen.queryByTestId("mhm-zoom-label")).toBeNull();
    expect(screen.getByTestId("mhm-badge-min").textContent).toMatch(/10/);
    expect(screen.getByTestId("mhm-badge-max").textContent).toMatch(/50/);
  });

  it("picking a different window pill while zoomed clears the zoom", () => {
    const pts = buildSpreadPoints(1_800_000);
    render(
      <MetricHistoryModal open onClose={() => undefined} title="X" points={pts}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t"
        onWindowChange={() => undefined} />,
    );
    const svg = screen.getByTestId("metric-history-modal-chart");
    firePointer(svg, "pointerDown", 200);
    firePointer(svg, "pointerMove", 400);
    firePointer(svg, "pointerUp", 400);
    expect(screen.getByTestId("mhm-reset-zoom")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mhm-window-pill-1h"));
    expect(screen.queryByTestId("mhm-reset-zoom")).toBeNull();
  });

  it("Escape during an in-progress drag cancels the drag and does not close the modal", () => {
    const onClose = vi.fn();
    const pts = buildSpreadPoints(1_800_000);
    render(
      <MetricHistoryModal open onClose={onClose} title="X" points={pts}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t" />,
    );
    const svg = screen.getByTestId("metric-history-modal-chart");
    firePointer(svg, "pointerDown", 200);
    firePointer(svg, "pointerMove", 400);
    expect(screen.getByTestId("mhm-brush")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mhm-brush")).toBeNull();
    expect(screen.queryByTestId("mhm-reset-zoom")).toBeNull();
  });

  it("Escape while zoomed clears the zoom without closing the modal", () => {
    const onClose = vi.fn();
    const pts = buildSpreadPoints(1_800_000);
    render(
      <MetricHistoryModal open onClose={onClose} title="X" points={pts}
        source="redis-timeseries" reason={null} windowMs={1_800_000} targetLabel="t" />,
    );
    const svg = screen.getByTestId("metric-history-modal-chart");
    firePointer(svg, "pointerDown", 200);
    firePointer(svg, "pointerMove", 400);
    firePointer(svg, "pointerUp", 400);
    expect(screen.getByTestId("mhm-reset-zoom")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mhm-reset-zoom")).toBeNull();
  });
});
