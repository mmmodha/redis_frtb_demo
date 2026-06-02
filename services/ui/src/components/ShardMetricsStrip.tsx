// Live shard metrics strip — renders one tile per primary shard. As of
// Wave 5.51 this is a pure presentational component: the parent
// Observability page owns the polling loop and passes the latest shards
// array down. The EventSource subscription was retired so the page has one
// consistent refresh cadence across every metric.
import type { ObservabilityShard } from "../lib/api";

export type Shard = ObservabilityShard;

export interface ShardMetricsStripProps {
  shards: readonly Shard[];
}

const NUMBER_FMT = new Intl.NumberFormat("en-US");

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

export function ShardMetricsStrip({ shards }: ShardMetricsStripProps) {
  return (
    <div className="shard-metrics-strip" data-testid="shard-metrics-strip">
      <div className="shard-metrics-strip__grid">
        {shards.map((s) => (
          <div key={s.shardId} className="shard-tile" data-testid="shard-tile">
            <div className="shard-tile__header">
              <span className="shard-tile__id">{s.shardId}</span>
              <span className="shard-tile__role" data-role={s.role}>
                {s.role}
              </span>
            </div>
            <div className="shard-tile__row">
              <span className="shard-tile__label">ops/sec</span>
              <span className="shard-tile__value">{NUMBER_FMT.format(s.opsPerSec)}</span>
            </div>
            <div className="shard-tile__row">
              <span className="shard-tile__label">slots</span>
              <span className="shard-tile__value">{NUMBER_FMT.format(s.slotCount)}</span>
            </div>
            <div className="shard-tile__row">
              <span className="shard-tile__label">memory</span>
              <span className="shard-tile__value">{formatBytes(s.usedMemoryBytes)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
