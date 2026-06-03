// Wave 5.18: tiny SVG sparkline for the per-bucket K_b drill-down. Single
// series renders the 10-tenor curve for Delta/Vega; two series overlays
// cvr_up vs cvr_down for Curvature. Stroke colours come from existing CSS
// custom properties — no new colour literals.

export interface SparklineProps {
  points: number[];
  labels?: string[];
  series?: 1 | 2;
  pointsB?: number[];
  width?: number;
  height?: number;
  ariaLabel?: string;
  // Wave 5.57 — tile variant. `filled` paints the area under the line; `dots`
  // controls per-point markers (default "all" for the original K_b drill-down
  // usage; "last" or "none" for the inline metric-tile sparkline).
  filled?: boolean;
  dots?: "all" | "last" | "none";
}

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 28;
const PAD_X = 2;
const PAD_Y = 3;

function buildPath(
  points: number[],
  min: number,
  max: number,
  width: number,
  height: number,
): string {
  if (points.length === 0) return "";
  const range = max - min || 1;
  const usableW = width - PAD_X * 2;
  const usableH = height - PAD_Y * 2;
  const stepX = points.length > 1 ? usableW / (points.length - 1) : 0;
  return points
    .map((p, i) => {
      const x = PAD_X + i * stepX;
      const y = PAD_Y + usableH - ((p - min) / range) * usableH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function Sparkline({
  points,
  labels,
  series = 1,
  pointsB,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  ariaLabel,
  filled = false,
  dots = "all",
}: SparklineProps) {
  const all = series === 2 && pointsB ? [...points, ...pointsB] : points;
  if (all.length === 0) {
    return <span className="sparkline sparkline--empty" aria-label={ariaLabel ?? "no data"}>—</span>;
  }
  const min = Math.min(...all);
  const max = Math.max(...all);
  const usableW = width - PAD_X * 2;
  const usableH = height - PAD_Y * 2;
  const range = max - min || 1;

  const pathA = buildPath(points, min, max, width, height);
  const pathB = series === 2 && pointsB ? buildPath(pointsB, min, max, width, height) : null;
  // Wave 5.57 — closed path for the area-fill variant; reuses the same x/y
  // mapping as `pathA` so the fill exactly tracks the stroke.
  const areaPath =
    filled && points.length > 0
      ? `${pathA} L${(PAD_X + (points.length - 1) * (points.length > 1 ? usableW / (points.length - 1) : 0)).toFixed(2)},${(PAD_Y + usableH).toFixed(2)} L${PAD_X.toFixed(2)},${(PAD_Y + usableH).toFixed(2)} Z`
      : null;

  const stepX = points.length > 1 ? usableW / (points.length - 1) : 0;
  const markerIndices: number[] =
    dots === "all" ? points.map((_, i) => i) : dots === "last" && points.length > 0 ? [points.length - 1] : [];

  return (
    <svg
      className="sparkline"
      data-testid="sparkline"
      data-series={series}
      data-filled={filled ? "1" : "0"}
      data-dots={dots}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? `sparkline with ${points.length} points`}
    >
      {areaPath ? (
        <path
          d={areaPath}
          fill="var(--sparkline-area, rgba(91, 211, 123, 0.18))"
          stroke="none"
          data-series-id="a-area"
        />
      ) : null}
      <path
        d={pathA}
        fill="none"
        stroke={series === 2 ? "var(--sparkline-up, #5BD37B)" : "var(--sparkline-line, var(--redis-text-link))"}
        strokeWidth={1.25}
        data-series-id="a"
      />
      {pathB ? (
        <path
          d={pathB}
          fill="none"
          stroke="var(--sparkline-down, var(--redis-hyper))"
          strokeWidth={1.25}
          data-series-id="b"
        />
      ) : null}
      {markerIndices.map((i) => {
        const p = points[i] as number;
        const x = PAD_X + i * stepX;
        const y = PAD_Y + usableH - ((p - min) / range) * usableH;
        const label = labels?.[i];
        const isLast = i === points.length - 1;
        return (
          <circle
            key={`a-${i}`}
            cx={x}
            cy={y}
            r={dots === "last" && isLast ? 2 : 1.5}
            fill="var(--sparkline-up, #5BD37B)"
            data-point-index={i}
            data-point-last={isLast ? "1" : "0"}
          >
            <title>{label ? `${label} → ${p}` : String(p)}</title>
          </circle>
        );
      })}
      {pathB && pointsB && dots === "all"
        ? pointsB.map((p, i) => {
            const x = PAD_X + i * stepX;
            const y = PAD_Y + usableH - ((p - min) / range) * usableH;
            const label = labels?.[i];
            return (
              <circle key={`b-${i}`} cx={x} cy={y} r={1.5} fill="var(--sparkline-down, var(--redis-hyper))" data-point-index={i}>
                <title>{label ? `${label} → ${p}` : String(p)}</title>
              </circle>
            );
          })
        : null}
    </svg>
  );
}
