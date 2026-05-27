// Latency-percentile helper used by the runner's live SSE export.
//
// The reservoir is a plain number[] of milliseconds. We accept linear
// interpolation rather than a streaming digest (HDR / t-digest) because the
// demo cluster's load test caps at ~50k samples per endpoint over a 5 min
// run, so sort-then-index stays well under 1 ms per snapshot.

export function percentile(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0]!;
  const sorted = [...samples].sort((a, b) => a - b);
  const clamped = Math.min(Math.max(q, 0), 1);
  const idx = clamped * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
