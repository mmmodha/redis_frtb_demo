// Status vocabulary mirrors the redis-brand-ui status-language reference.
export type MetricStatus = "live" | "sampled" | "stale" | "pending" | "modeled" | "derived";

export interface MetricTileProps {
  label: string;
  value: string | number;
  unit?: string;
  status?: MetricStatus;
}

export function MetricTile({ label, value, unit, status }: MetricTileProps) {
  return (
    <div className="metric-tile">
      <div className="metric-tile__label">{label}</div>
      <div className="metric-tile__value-row">
        <span className="metric-tile__value">{value}</span>
        {unit ? <span className="metric-tile__unit">{unit}</span> : null}
      </div>
      {status ? (
        <span className="metric-tile__status" data-status={status}>
          {status}
        </span>
      ) : null}
    </div>
  );
}
