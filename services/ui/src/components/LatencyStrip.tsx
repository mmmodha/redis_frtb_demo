// Wave 5.22 — hand-rolled SVG strip chart that replaces the percentile-tile
// grid in PivotPanel. Two overlaid bar series (server in Redis-red front,
// client at 60% opacity behind) plus three dashed reference lines for
// p50/p95/p99 of the server series. The p99 line flips from green
// (<100ms) to amber (≥100ms) so the "Sub-100ms" promise is visible at
// a glance. Path/colour conventions match Sparkline.tsx — no chart lib.

export interface LatencyStripProps {
  server: number[];
  client: number[];
  width?: number;
  height?: number;
}

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 140;
const PAD_TOP = 8;
const PAD_BOTTOM = 14;
const PAD_LEFT = 4;
const PAD_RIGHT = 56; // room for p50/p95/p99 right-edge labels
const HIST_WINDOW = 100;
const P99_AMBER_THRESHOLD = 100;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round((sorted[idx] ?? 0) * 1000) / 1000;
}

export function LatencyStrip({
  server,
  client,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: LatencyStripProps): JSX.Element {
  const count = Math.max(server.length, client.length);
  const p50 = percentile(server, 50);
  const p95 = percentile(server, 95);
  const p99 = percentile(server, 99);
  const last = server.length > 0 ? server[server.length - 1] ?? 0 : 0;
  const lastClient = client.length > 0 ? client[client.length - 1] ?? 0 : 0;
  const p99IsAmber = p99 >= P99_AMBER_THRESHOLD;

  const usableW = width - PAD_LEFT - PAD_RIGHT;
  const usableH = height - PAD_TOP - PAD_BOTTOM;
  // y-axis max: cap to 1.2x the largest observed sample so single-spike
  // outliers don't squash the rest of the chart flat. Floor at 100ms so
  // the p99 reference line lives in a meaningful place when latency is low.
  const allValues = [...server, ...client];
  const observedMax = allValues.length > 0 ? Math.max(...allValues) : 0;
  const yMax = Math.max(100, Math.ceil((observedMax * 1.2) / 10) * 10);

  function yFor(ms: number): number {
    const clamped = Math.max(0, Math.min(yMax, ms));
    return PAD_TOP + usableH - (clamped / yMax) * usableH;
  }
  // Bar pair geometry: split each slot between the two series so the client
  // bar stays visible behind the server bar.
  const slotW = usableW / HIST_WINDOW;
  const barW = Math.max(1.5, slotW - 1);

  const empty = count === 0;

  return (
    <div className="latency-strip" data-testid="latency-strip" data-empty={empty ? "true" : "false"}>
      <div className="latency-strip__headline" data-testid="latency-strip-headline">
        <span className="latency-strip__last">
          LAST: <strong>{last}</strong> ms server · <strong>{lastClient}</strong> ms client
        </span>
        <span className="latency-strip__pcts">
          p50/p95/p99 (server): <strong>{p50}</strong> / <strong>{p95}</strong> /{" "}
          <strong className={p99IsAmber ? "latency-strip__p99--amber" : "latency-strip__p99--green"}>
            {p99}
          </strong>{" "}
          ms
        </span>
        <span className="latency-strip__count">n = {count}</span>
      </div>
      <svg
        className="latency-strip__svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Latency strip with ${count} samples`}
      >
        {empty ? (
          <>
            <line
              x1={PAD_LEFT}
              y1={PAD_TOP + usableH}
              x2={PAD_LEFT + usableW}
              y2={PAD_TOP + usableH}
              stroke="var(--redis-border-secondary)"
              strokeDasharray="2 4"
              strokeWidth={1}
            />
            <text
              x={width / 2}
              y={height / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="var(--redis-text-muted)"
              fontSize={12}
              className="latency-strip__empty-text"
            >
              Run a search to start collecting samples.
            </text>
          </>
        ) : (
          <>
            {client.map((c, i) => {
              const s = server[i] ?? 0;
              const x = PAD_LEFT + i * slotW;
              const yC = yFor(c);
              const yS = yFor(s);
              const baseY = PAD_TOP + usableH;
              return (
                <g key={i} data-bar-index={i} className="latency-strip__bar-group">
                  <rect
                    x={x}
                    y={yC}
                    width={barW}
                    height={Math.max(0, baseY - yC)}
                    className="latency-strip__bar latency-strip__bar--client"
                    data-series="client"
                  >
                    <title>{`Run #${i + 1} · ${s}ms server · ${c}ms client`}</title>
                  </rect>
                  <rect
                    x={x + barW * 0.25}
                    y={yS}
                    width={Math.max(1, barW * 0.6)}
                    height={Math.max(0, baseY - yS)}
                    className="latency-strip__bar latency-strip__bar--server"
                    data-series="server"
                  >
                    <title>{`Run #${i + 1} · ${s}ms server · ${c}ms client`}</title>
                  </rect>
                </g>
              );
            })}
            {[
              { label: "p50", value: p50, cls: "latency-strip__refline--p50" },
              { label: "p95", value: p95, cls: "latency-strip__refline--p95" },
              {
                label: "p99",
                value: p99,
                cls: p99IsAmber
                  ? "latency-strip__refline--p99 latency-strip__refline--amber"
                  : "latency-strip__refline--p99 latency-strip__refline--green",
              },
            ].map((ref) => {
              const y = yFor(ref.value);
              return (
                <g key={ref.label} className={`latency-strip__refline ${ref.cls}`}>
                  <line
                    x1={PAD_LEFT}
                    y1={y}
                    x2={PAD_LEFT + usableW}
                    y2={y}
                    strokeDasharray="4 3"
                    strokeWidth={1}
                  />
                  <text
                    x={PAD_LEFT + usableW + 4}
                    y={y}
                    dominantBaseline="middle"
                    fontSize={10}
                  >
                    {ref.label} {ref.value}ms
                  </text>
                </g>
              );
            })}
          </>
        )}
      </svg>
    </div>
  );
}

export default LatencyStrip;
