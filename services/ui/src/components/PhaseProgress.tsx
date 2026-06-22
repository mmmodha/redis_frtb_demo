// Wave 7.0.6.18 — Shared phase progress bar surfaced by the IngestPanel for
// each of the three phases of an ingest run (Generation, Ingest, Indexing).
// One component, one CSS block, three vertically-stacked instances so the
// operator sees a coherent picture of where the run currently is.
//
// Render shape:
//   <label>            ████████░░░░░  <pct>%
//   <done> / <total> (<pct>%) · <rate> rows/s · ETA <m:ss>   [Cancel]
//
// ETA formatting: rate≤0 ⇒ "—"; <1h ⇒ "m:ss"; otherwise "h:mm:ss".
// Callers can override the meta line via `metaOverride` (used by
// IndexingProgress when it switches to the "Indexing complete" toast state).

import type { ReactNode } from "react";

export interface PhaseProgressProps {
  label: string;
  done: number;
  total: number;
  ratePerSec: number;
  status?: string;
  error?: string | null;
  onCancel?: () => void;
  // Test-id prefix is required so each stacked instance has stable, distinct
  // hooks (e.g. "phase-progress-generation" → "-text" / "-stats" / "-error").
  testIdPrefix: string;
  // Optional unit appended after "done / total" in the text element (e.g.
  // "indexed" so the Indexing bar reads "750 / 1,000 indexed (75%)" and
  // preserves the legacy IndexingProgress copy + tests).
  unit?: string;
  // When provided, replaces the default text + stats meta line. Used by the
  // Indexing bar's completion toast.
  metaOverride?: ReactNode;
  // Optional extra class merged onto the fill div so the Indexing instance
  // can keep its `.indexing-progress__fill` accent + legacy DOM hook.
  fillClassName?: string;
}

function clampPct(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  const raw = (done / total) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, raw));
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function computePhaseEtaSeconds(done: number, total: number, ratePerSec: number): number | null {
  if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  const remaining = Math.max(0, total - done);
  return remaining / ratePerSec;
}

export function PhaseProgress(props: PhaseProgressProps): JSX.Element {
  const { label, done, total, ratePerSec, status, error, onCancel, testIdPrefix, unit, metaOverride, fillClassName } = props;
  const pct = clampPct(done, total);
  const pctRounded = Math.round(pct);
  const etaSec = computePhaseEtaSeconds(done, total, ratePerSec);
  const etaText = etaSec === null ? "—" : formatEta(etaSec);
  const rateText = ratePerSec > 0 && Number.isFinite(ratePerSec)
    ? Math.round(ratePerSec).toLocaleString("en-US")
    : "0";
  const unitSuffix = unit ? ` ${unit}` : "";

  return (
    <div className="phase-progress" data-testid={testIdPrefix} role="status" aria-live="polite">
      <div className="phase-progress__header">
        <span className="phase-progress__label" data-testid={`${testIdPrefix}-label`}>{label}</span>
        <span className="phase-progress__pct" data-testid={`${testIdPrefix}-pct`}>{pctRounded}%</span>
      </div>
      <div
        className="phase-progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pctRounded}
        aria-label={label}
      >
        <div
          className={fillClassName ? `phase-progress__fill ${fillClassName}` : "phase-progress__fill"}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="phase-progress__meta">
        {metaOverride !== undefined ? (
          metaOverride
        ) : (
          <>
            <span data-testid={`${testIdPrefix}-text`}>
              {done.toLocaleString("en-US")} / {total.toLocaleString("en-US")}{unitSuffix} ({pctRounded}%)
            </span>
            <span className="phase-progress__stats" data-testid={`${testIdPrefix}-stats`}>
              {rateText} rows/s · ETA {etaText}{status ? ` · status ${status}` : ""}
            </span>
            {onCancel ? (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={onCancel}
                data-testid={`${testIdPrefix}-cancel`}
              >
                Cancel
              </button>
            ) : null}
          </>
        )}
      </div>
      {error ? (
        <div className="phase-progress__error" role="alert" data-testid={`${testIdPrefix}-error`}>{error}</div>
      ) : null}
    </div>
  );
}

export default PhaseProgress;
