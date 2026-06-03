// Status vocabulary mirrors the redis-brand-ui status-language reference.
import { Sparkline } from "./Sparkline";

export type MetricStatus = "live" | "sampled" | "stale" | "pending" | "modeled" | "derived";

// Wave 5.57 — optional inline sparkline + click-to-open contract. Tiles
// without `history` keep their existing static-`div` appearance; tiles with
// `history` become a `button` that calls `onClick` (Observability wires this
// to open the popout modal).
export interface MetricTileHistory {
  points: number[];
  ariaLabel?: string;
}

export interface MetricTileProps {
  label: string;
  value: string | number;
  unit?: string;
  status?: MetricStatus;
  history?: MetricTileHistory;
  onClick?: () => void;
}

export function MetricTile({ label, value, unit, status, history, onClick }: MetricTileProps) {
  const interactive = typeof onClick === "function";
  const inner = (
    <>
      <div className="metric-tile__label">{label}</div>
      <div className="metric-tile__value-row">
        <span className="metric-tile__value">{value}</span>
        {unit ? <span className="metric-tile__unit">{unit}</span> : null}
      </div>
      {history ? (
        <div className="metric-tile__sparkline">
          <Sparkline
            points={history.points}
            width={120}
            height={28}
            filled
            dots="last"
            ariaLabel={history.ariaLabel ?? `${label} history`}
          />
        </div>
      ) : null}
      {status ? (
        <span className="metric-tile__status" data-status={status}>
          {status}
        </span>
      ) : null}
    </>
  );
  if (interactive) {
    return (
      <button
        type="button"
        className="metric-tile metric-tile--interactive"
        data-testid="metric-tile-button"
        onClick={onClick}
        aria-label={`${label} history`}
      >
        {inner}
      </button>
    );
  }
  return <div className="metric-tile">{inner}</div>;
}
