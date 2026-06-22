// Wave 7.0.6.21 — bulk-loader Ingest lane rate gauge. Replaces the legacy
// "Ingest" PhaseProgress bar so the middle lane in the IngestPanel three-row
// stack tells a rate story (rps + in-flight capacity + throttle chip) rather
// than a percentage. The mental model:
//   Generation → progress %   (denominator is known: rowsTotal)
//   Ingest     → rate gauge   (no denominator, capacity bar caps at 1.0)
//   Indexing   → progress %   (denominator is generated_count)
//
// This kills the historical ">100%" Ingest progress bar (Wave 6.19/6.20) by
// removing the denominator outright in the middle lane.
//
// Props are passed in from IngestPanel (which owns the polling tick and the
// 5-sample rate smoothing), so this surface stays a pure presentational
// component — no fetches, no internal timers.
//
// Layout (top-to-bottom inside one phase-progress row so width/rhythm
// matches the surrounding Generation + Indexing bars):
//   1. Big "NN,NNN/s"  — smoothedRps in human-readable form
//   2. "in-flight NN / NNN" sub-line + thin horizontal capacity bar
//      (filled = in_flight / high_water; tone derived from headroom_pct).
//   3. Throttle chip (red / amber / hidden) driven by throttled +
//      recent_429_count.
//
// Accessibility:
//   - Container is role="region" aria-label="Ingest rate".
//   - Throttle chip is role="status" so screen readers announce flips.

export interface RateGaugeProps {
  rps: number;
  smoothedRps: number;
  inFlight: number;
  high_water: number;
  throttled: boolean;
  headroomPct: number;
  recent429Count: number;
  label: string;
  testId?: string;
}

type CapacityTone = "ok" | "warn" | "err";

function pickCapacityTone(headroomPct: number): CapacityTone {
  if (!Number.isFinite(headroomPct)) return "ok";
  if (headroomPct < 0.2) return "err";
  if (headroomPct < 0.5) return "warn";
  return "ok";
}

function clampCapacityPct(inFlight: number, highWater: number): number {
  if (!Number.isFinite(inFlight) || !Number.isFinite(highWater) || highWater <= 0) return 0;
  const raw = (inFlight / highWater) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, raw));
}

// Compact "NN,NNN/s" style headline. Mirrors the IngestPanel
// formatIntCompact helper but emits one-decimal-place K/M suffixes so a
// 70k rps run reads "70.0K/s" rather than "70000/s".
function formatRatePerSec(rps: number): string {
  if (!Number.isFinite(rps) || rps <= 0) return "0/s";
  const abs = Math.abs(rps);
  if (abs >= 1_000_000) {
    return `${(rps / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M/s`;
  }
  if (abs >= 1_000) {
    return `${(rps / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K/s`;
  }
  return `${Math.round(rps).toLocaleString("en-US")}/s`;
}

export function RateGauge(props: RateGaugeProps): JSX.Element {
  const { smoothedRps, inFlight, high_water, throttled, headroomPct, recent429Count, label, testId } = props;
  const prefix = testId ?? "rate-gauge";
  const tone = pickCapacityTone(headroomPct);
  const pct = clampCapacityPct(inFlight, high_water);
  const safeRecent429 = Math.max(0, Math.trunc(recent429Count));

  let chip: JSX.Element | null = null;
  if (throttled) {
    chip = (
      <span
        className="rate-gauge__chip pill pill--err"
        role="status"
        data-testid={`${prefix}-chip`}
        data-state="throttled"
      >
        THROTTLED · {safeRecent429} 429/10s
      </span>
    );
  } else if (safeRecent429 > 0) {
    chip = (
      <span
        className="rate-gauge__chip pill pill--warn"
        role="status"
        data-testid={`${prefix}-chip`}
        data-state="recovering"
      >
        recovering · {safeRecent429} 429/10s
      </span>
    );
  }

  return (
    <div
      className="rate-gauge phase-progress"
      data-testid={prefix}
      role="region"
      aria-label="Ingest rate"
    >
      <div className="phase-progress__header">
        <span className="phase-progress__label" data-testid={`${prefix}-label`}>{label}</span>
        <span
          className="rate-gauge__headline"
          data-testid={`${prefix}-rate`}
          aria-label={`Ingest rate ${Math.round(smoothedRps)} rows per second`}
        >
          {formatRatePerSec(smoothedRps)}
        </span>
      </div>
      <div
        className="rate-gauge__capacity-bar phase-progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Bulk-loader in-flight capacity"
        data-tone={tone}
        data-testid={`${prefix}-capacity-bar`}
      >
        <div
          className="rate-gauge__capacity-fill phase-progress__fill"
          data-tone={tone}
          style={{ width: `${pct}%` }}
          data-testid={`${prefix}-capacity-fill`}
        />
      </div>
      <div className="phase-progress__meta rate-gauge__meta">
        <span data-testid={`${prefix}-in-flight`}>
          in-flight {Math.max(0, Math.trunc(inFlight)).toLocaleString("en-US")} / {Math.max(0, Math.trunc(high_water)).toLocaleString("en-US")}
        </span>
        {chip}
      </div>
    </div>
  );
}

export default RateGauge;
