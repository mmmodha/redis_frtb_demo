export interface ShardTiming {
  id: string;
  label: string;
  ms: number;
}

export interface TimingStripProps {
  shards: ShardTiming[];
}

export function TimingStrip({ shards }: TimingStripProps) {
  if (shards.length === 0) {
    return <div className="timing-strip__empty">no shard timings yet</div>;
  }
  const max = Math.max(...shards.map((s) => s.ms), 1);
  return (
    <div className="timing-strip" role="list">
      {shards.map((s) => (
        <div className="timing-strip__row" role="listitem" key={s.id}>
          <span className="timing-strip__label">{s.label}</span>
          <div className="timing-strip__bar" aria-hidden="true">
            <div
              className="timing-strip__bar-fill"
              style={{ transform: `scaleX(${Math.max(s.ms / max, 0.02)})` }}
            />
          </div>
          <span className="timing-strip__ms">{s.ms} ms</span>
        </div>
      ))}
    </div>
  );
}
