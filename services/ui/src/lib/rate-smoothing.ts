// Wave 7.0.6.21 — fixed-window rolling-buffer helpers used by the IngestPanel
// to smooth the per-phase rps counters (5-sample mean). Extracted from
// services/ui/src/panels/IngestPanel.tsx so the new RateGauge surface and
// the existing PhaseProgress poll tick share the same smoothing window
// without two divergent implementations. The IngestPanel re-exports these
// symbols for backward compat with callers that still import from there.

export const PHASE_RATE_WINDOW = 5;

export function pushPhaseRateSample(buf: number[], next: number): number[] {
  if (!Number.isFinite(next) || next < 0) return buf;
  const out = buf.length >= PHASE_RATE_WINDOW
    ? [...buf.slice(buf.length - PHASE_RATE_WINDOW + 1), next]
    : [...buf, next];
  return out;
}

export function meanPhaseRate(buf: number[]): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (const v of buf) sum += v;
  return sum / buf.length;
}
