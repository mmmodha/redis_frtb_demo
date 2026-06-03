// Wave 5.57 — centred popout chart for a single Cluster snapshot metric.
// Minimal SVG renderer (no chart library): X labels driven by the selected
// window, Y min/max, hoverable tooltip, min/max/avg badges, footer source
// label. Closes on Esc, the X button, or click on the backdrop.
// Wave 5.61 — pill-row window selector (30m / 1h / 2h / 5h) and a
// borderless, flex-centred close button.
// Wave 5.63 — click-and-drag brush-to-zoom over the loaded points.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ObservabilityHistoryPoint } from "../lib/api";
import type { HistorySource, HistoryReason } from "../hooks/useMetricHistory";

export interface MetricHistoryModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  unit?: string;
  formatValue?: (v: number) => string;
  points: ObservabilityHistoryPoint[];
  source: HistorySource;
  reason: HistoryReason;
  windowMs: number;
  targetLabel: string | null;
  onWindowChange?: (windowMs: number) => void;
}

const CHART_W = 760;
const CHART_H = 280;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;

interface Hover { x: number; y: number; p: ObservabilityHistoryPoint }

interface WindowOption { ms: number; label: string }
const WINDOW_OPTIONS: WindowOption[] = [
  { ms: 1_800_000, label: "30m" },
  { ms: 3_600_000, label: "1h" },
  { ms: 7_200_000, label: "2h" },
  { ms: 18_000_000, label: "5h" },
];

// Tick generation per selected window. Returned order is `[now, ..., oldest]`
// to match the existing X-axis test expectation (ticks[0] === "now").
export function xTicksForWindow(windowMs: number, now: number): Array<{ ms: number; label: string }> {
  if (windowMs <= 1_800_000) {
    return [0, 5, 10, 15, 20, 25, 30].map((m) => ({
      ms: now - m * 60_000,
      label: m === 0 ? "now" : `-${m}m`,
    }));
  }
  if (windowMs <= 3_600_000) {
    return [0, 10, 20, 30, 40, 50, 60].map((m) => ({
      ms: now - m * 60_000,
      label: m === 0 ? "now" : `-${m}m`,
    }));
  }
  if (windowMs <= 7_200_000) {
    return [
      { ms: now, label: "now" },
      { ms: now - 30 * 60_000, label: "-30m" },
      { ms: now - 60 * 60_000, label: "-1h" },
      { ms: now - 90 * 60_000, label: "-90m" },
      { ms: now - 120 * 60_000, label: "-2h" },
    ];
  }
  return [0, 1, 2, 3, 4, 5].map((h) => ({
    ms: now - h * 3_600_000,
    label: h === 0 ? "now" : `-${h}h`,
  }));
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fmtWindow(windowMs: number): string {
  if (windowMs < 3_600_000) {
    const mins = Math.max(1, Math.round(windowMs / 60_000));
    return `${mins}m`;
  }
  const hours = Math.round(windowMs / 3_600_000);
  return `${hours}h`;
}

function sourceFooter(
  source: HistorySource,
  reason: HistoryReason,
  windowMs: number,
  points: ObservabilityHistoryPoint[],
  zoom: { fromMs: number; toMs: number } | null,
): string {
  const zoomSuffix = zoom ? ` · zoomed ${fmtClock(zoom.fromMs)} → ${fmtClock(zoom.toMs)}` : "";
  if (source === "redis-timeseries") {
    return `Source: Redis TimeSeries · last ${fmtWindow(windowMs)}${zoomSuffix}`;
  }
  if (source === "ring-buffer") {
    const first = points[0];
    const last = points[points.length - 1];
    const spanMin = first && last ? Math.max(1, Math.round((last.t - first.t) / 60_000)) : 0;
    const suffix = reason === "module-not-loaded"
      ? " · RedisTimeSeries module not loaded on this target."
      : "";
    return `Source: this browser · last ${spanMin}m${suffix}${zoomSuffix}`;
  }
  return "Source: —";
}

export function MetricHistoryModal({
  open, onClose, title, unit, formatValue, points, source, reason, windowMs, targetLabel, onWindowChange,
}: MetricHistoryModalProps) {
  const [hover, setHover] = useState<Hover | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The `windowMs` prop is the DEFAULT — internal state owns the current
  // selection so the pill row can drive re-fetches via `onWindowChange`.
  const [selectedWindowMs, setSelectedWindowMs] = useState<number>(windowMs);
  // Wave 5.63 — brush-to-zoom client-side over the loaded points.
  const [zoomRange, setZoomRange] = useState<{ fromMs: number; toMs: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  // Keep local selection in sync if the parent supplies a new default
  // (e.g. when the modal is reopened with the default window).
  useEffect(() => { setSelectedWindowMs(windowMs); setZoomRange(null); }, [windowMs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (drag !== null) { e.stopPropagation(); setDrag(null); return; }
      if (zoomRange !== null) { e.stopPropagation(); setZoomRange(null); return; }
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, drag, zoomRange]);

  if (!open) return null;
  const fmt = formatValue ?? ((v: number) => v.toLocaleString("en-US"));

  const pickWindow = (ms: number): void => {
    if (ms === selectedWindowMs) return;
    setSelectedWindowMs(ms);
    setZoomRange(null);
    onWindowChange?.(ms);
  };
  const selectedIdx = Math.max(0, WINDOW_OPTIONS.findIndex((o) => o.ms === selectedWindowMs));
  const onPillKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number): void => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = (idx + 1) % WINDOW_OPTIONS.length;
      pickWindow(WINDOW_OPTIONS[next]!.ms);
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="mhm-window-pill-${WINDOW_OPTIONS[next]!.label}"]`,
      );
      btn?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (idx - 1 + WINDOW_OPTIONS.length) % WINDOW_OPTIONS.length;
      pickWindow(WINDOW_OPTIONS[prev]!.ms);
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="mhm-window-pill-${WINDOW_OPTIONS[prev]!.label}"]`,
      );
      btn?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickWindow(WINDOW_OPTIONS[idx]!.ms);
    }
  };

  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const now = Date.now();
  const baseFromMs = now - selectedWindowMs;
  // Wave 5.63 — when zoomed, the visible chart slice and all derived state
  // (stats, ticks, path) come from `effectiveFromMs..effectiveToMs`.
  const effectiveFromMs = zoomRange ? zoomRange.fromMs : baseFromMs;
  const effectiveToMs = zoomRange ? zoomRange.toMs : now;
  const effectiveWindowMs = Math.max(1, effectiveToMs - effectiveFromMs);
  const visiblePoints = points.filter((p) => p.t >= effectiveFromMs && p.t <= effectiveToMs);

  const stats = (() => {
    if (visiblePoints.length === 0) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const p of visiblePoints) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
      sum += p.v;
    }
    return { min, max, avg: sum / visiblePoints.length };
  })();

  const yMin = stats ? Math.min(stats.min, stats.max) : 0;
  const yMax = stats ? Math.max(stats.min, stats.max) : 1;
  const yRange = (yMax - yMin) || 1;
  const xScale = (t: number): number =>
    PAD_L + ((Math.max(effectiveFromMs, Math.min(effectiveToMs, t)) - effectiveFromMs) / effectiveWindowMs) * innerW;
  const yScale = (v: number): number =>
    PAD_T + innerH - ((v - yMin) / yRange) * innerH;

  const path = visiblePoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(2)},${yScale(p.v).toFixed(2)}`)
    .join(" ");
  const areaPath = visiblePoints.length > 0
    ? `${path} L${xScale(visiblePoints[visiblePoints.length - 1]!.t).toFixed(2)},${(PAD_T + innerH).toFixed(2)} L${xScale(visiblePoints[0]!.t).toFixed(2)},${(PAD_T + innerH).toFixed(2)} Z`
    : "";

  // Convert a clientX (from a Pointer Event) into an SVG-coordinate x,
  // clamped to the inner chart area. Accounts for the viewBox→pixel scale.
  const clientXToSvgX = (clientX: number): number | null => {
    const svg = svgRef.current; if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return null;
    const raw = ((clientX - rect.left) / rect.width) * CHART_W;
    return Math.max(PAD_L, Math.min(PAD_L + innerW, raw));
  };
  const svgXToTime = (svgX: number): number =>
    effectiveFromMs + ((svgX - PAD_L) / innerW) * effectiveWindowMs;

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const svgX = clientXToSvgX(e.clientX); if (svgX == null) return;
    try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
    setDrag({ x0: svgX, x1: svgX });
    setHover(null);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag !== null) {
      const svgX = clientXToSvgX(e.clientX); if (svgX == null) return;
      setDrag({ x0: drag.x0, x1: svgX });
      return;
    }
    if (visiblePoints.length === 0) return;
    const svgX = clientXToSvgX(e.clientX); if (svgX == null) return;
    let best = visiblePoints[0]!, bestDx = Infinity;
    for (const p of visiblePoints) {
      const dx = Math.abs(xScale(p.t) - svgX);
      if (dx < bestDx) { best = p; bestDx = dx; }
    }
    setHover({ x: xScale(best.t), y: yScale(best.v), p: best });
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag === null) return;
    try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    const { x0, x1 } = drag;
    setDrag(null);
    if (Math.abs(x1 - x0) < 6) return;
    const xMin = Math.min(x0, x1);
    const xMax = Math.max(x0, x1);
    setZoomRange({ fromMs: svgXToTime(xMin), toMs: svgXToTime(xMax) });
  };
  const onPointerCancel = (e: ReactPointerEvent<SVGSVGElement>): void => {
    try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    setDrag(null);
  };
  const onPointerLeave = (): void => { if (drag === null) setHover(null); };

  const xTicks = zoomRange
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const ms = effectiveFromMs + f * effectiveWindowMs;
        return { ms, label: fmtClock(ms) };
      })
    : xTicksForWindow(selectedWindowMs, now);

  const emptyMsg = visiblePoints.length === 0
    ? zoomRange !== null
      ? "No samples in the zoomed range."
      : source === "redis-timeseries" && reason === "no-data-yet"
        ? "Recording… first sample in a few seconds."
        : source === "ring-buffer"
          ? "Collecting samples… first sample in a few seconds."
          : "No data yet."
    : null;

  return (
    <div
      className="metric-history-modal__backdrop"
      data-testid="metric-history-modal"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="metric-history-modal" role="dialog" aria-modal="true" aria-label={`${title} history`}>
        <header className="metric-history-modal__header">
          <h2>{title}{unit ? ` · ${unit}` : ""}</h2>
          {targetLabel ? <span className="metric-history-modal__target">{targetLabel}</span> : null}
          <button
            type="button"
            className="metric-history-modal__close"
            aria-label="Close"
            data-testid="metric-history-modal-close"
            onClick={onClose}
          >
            <span aria-hidden="true" className="metric-history-modal__close-glyph">×</span>
          </button>
        </header>
        <div className="metric-history-modal__window-selector-row">
          <div
            className="metric-history-modal__window-selector"
            role="radiogroup"
            aria-label="Chart window"
            data-testid="mhm-window-selector"
          >
            {WINDOW_OPTIONS.map((opt, idx) => {
              const checked = opt.ms === selectedWindowMs;
              return (
                <button
                  key={opt.ms}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked || (selectedIdx === -1 && idx === 0) ? 0 : -1}
                  className="metric-history-modal__window-pill"
                  data-testid={`mhm-window-pill-${opt.label}`}
                  onClick={() => pickWindow(opt.ms)}
                  onKeyDown={(e) => onPillKeyDown(e, idx)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {zoomRange !== null ? (
            <button
              type="button"
              className="metric-history-modal__reset-zoom"
              data-testid="mhm-reset-zoom"
              onClick={() => setZoomRange(null)}
            >
              Reset zoom
            </button>
          ) : null}
        </div>
        <div className="metric-history-modal__badges">
          <span data-testid="mhm-badge-min">min&nbsp;<strong>{stats ? fmt(stats.min) : "—"}</strong></span>
          <span data-testid="mhm-badge-max">max&nbsp;<strong>{stats ? fmt(stats.max) : "—"}</strong></span>
          <span data-testid="mhm-badge-avg">avg&nbsp;<strong>{stats ? fmt(stats.avg) : "—"}</strong></span>
        </div>
        <svg
          ref={svgRef}
          className={`metric-history-modal__chart${drag !== null ? " metric-history-modal__chart--dragging" : ""}`}
          data-testid="metric-history-modal-chart"
          width="100%"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          role="img"
          aria-label={`${title} chart over the last ${Math.round(selectedWindowMs / 60000)} minutes`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={onPointerLeave}
        >
          <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} fill="var(--redis-bg-tertiary)" />
          {/* Y gridlines + min/max labels */}
          <line x1={PAD_L} y1={PAD_T} x2={PAD_L + innerW} y2={PAD_T} stroke="var(--redis-border-secondary)" strokeWidth={1} />
          <line x1={PAD_L} y1={PAD_T + innerH} x2={PAD_L + innerW} y2={PAD_T + innerH} stroke="var(--redis-border-secondary)" strokeWidth={1} />
          <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" fontSize={11} fill="var(--redis-text-secondary)">{stats ? fmt(yMax) : ""}</text>
          <text x={PAD_L - 6} y={PAD_T + innerH} textAnchor="end" fontSize={11} fill="var(--redis-text-secondary)">{stats ? fmt(yMin) : ""}</text>
          {/* X ticks */}
          {xTicks.map((t, i) => (
            <g key={i}>
              <line x1={xScale(t.ms)} y1={PAD_T + innerH} x2={xScale(t.ms)} y2={PAD_T + innerH + 4} stroke="var(--redis-border-secondary)" />
              <text x={xScale(t.ms)} y={PAD_T + innerH + 18} textAnchor="middle" fontSize={11} fill="var(--redis-text-secondary)" data-testid="mhm-x-tick">{t.label}</text>
            </g>
          ))}
          {areaPath ? <path d={areaPath} fill="var(--sparkline-area, rgba(91, 211, 123, 0.18))" stroke="none" /> : null}
          {path ? <path d={path} fill="none" stroke="var(--sparkline-line, var(--redis-text-link))" strokeWidth={1.5} /> : null}
          {drag !== null ? (
            <rect
              className="metric-history-modal__brush"
              data-testid="mhm-brush"
              x={Math.min(drag.x0, drag.x1)}
              y={PAD_T}
              width={Math.abs(drag.x1 - drag.x0)}
              height={innerH}
              fill="var(--redis-text-link)"
              fillOpacity={0.12}
              stroke="var(--redis-text-link)"
              strokeOpacity={0.5}
              strokeWidth={1}
              pointerEvents="none"
            />
          ) : null}
          {zoomRange !== null ? (
            <text
              className="metric-history-modal__zoom-label"
              data-testid="mhm-zoom-label"
              x={PAD_L + 4}
              y={PAD_T + 12}
              fontSize={11}
              fill="var(--redis-text-secondary)"
            >
              Zoomed: {fmtClock(zoomRange.fromMs)} → {fmtClock(zoomRange.toMs)}
            </text>
          ) : null}
          {hover && drag === null ? (
            <g data-testid="mhm-hover">
              <line x1={hover.x} y1={PAD_T} x2={hover.x} y2={PAD_T + innerH} stroke="var(--redis-text-secondary)" strokeDasharray="2 2" />
              <circle cx={hover.x} cy={hover.y} r={3} fill="var(--sparkline-up, #5BD37B)" />
              <text x={hover.x + 8} y={hover.y - 8} fontSize={11} fill="var(--redis-text-primary)">{fmt(hover.p.v)} · {fmtClock(hover.p.t)}</text>
            </g>
          ) : null}
        </svg>
        {emptyMsg ? <div className="metric-history-modal__empty" role="status">{emptyMsg}</div> : null}
        <footer className="metric-history-modal__footer" data-testid="metric-history-modal-source">
          {sourceFooter(source, reason, selectedWindowMs, points, zoomRange)}
        </footer>
      </div>
    </div>
  );
}
