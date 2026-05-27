// Live shard metrics strip — subscribes to /observability/shards/stream and
// renders one tile per primary shard. Used in the Observability panel to
// power the Wave 4.2 "200 concurrent analysts" demo moment.
import { useEffect, useState } from "react";

export interface Shard {
  shardId: string;
  role: string;
  opsPerSec: number;
  slotCount: number;
  usedMemoryBytes: number;
  netInBytes: number;
  netOutBytes: number;
}

export interface ShardMetricsStripProps {
  streamUrl?: string;
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

export function ShardMetricsStrip({
  streamUrl = "/observability/shards/stream",
}: ShardMetricsStripProps) {
  const [shards, setShards] = useState<Shard[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(streamUrl);
    es.onmessage = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as Shard[];
        if (Array.isArray(parsed)) setShards(parsed);
      } catch {
        // ignore malformed frame; next tick may recover
      }
    };
    es.onerror = () => {
      setError("stream disconnected");
    };
    return () => {
      es.close();
    };
  }, [streamUrl]);

  return (
    <div className="shard-metrics-strip" data-testid="shard-metrics-strip">
      {error ? (
        <div className="shard-metrics-strip__error" role="alert">
          {error}
        </div>
      ) : null}
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
