// Wave 7.0.8 — stabilize ingest telemetry tiles. FT.SEARCH counts can
// briefly read 0 when the index is rebuilding or the api degrades; raw
// 1s deltas produce spikey rows/sec.

export function stabilizeIndexCount(
  previous: number,
  next: number,
  opts?: { indexName?: string | null; monotonic?: boolean },
): number {
  if (opts?.indexName === null && previous > 0) return previous;
  if (!Number.isFinite(next) || next < 0) return previous;
  // Transient miss while the index still exists — hold the last good count.
  if (previous > 1_000 && next === 0 && opts?.indexName !== null) return previous;
  if (opts?.monotonic && previous > 0) return Math.max(previous, next);
  // Small mid-run dips are poll glitches; large drops (flush/stop) pass through.
  if (previous > 100 && next < previous && next > 0 && next >= previous * 0.9) return previous;
  return next;
}

export function pushTelemetryRateSample(buffer: number[], sample: number, window = 5): number[] {
  const v = clampTelemetryRateSample(sample, buffer);
  return [...buffer, v].slice(-window);
}

export function meanTelemetryRate(buffer: number[]): number {
  if (buffer.length === 0) return 0;
  return buffer.reduce((a, b) => a + b, 0) / buffer.length;
}

export function medianTelemetryRate(buffer: number[]): number {
  if (buffer.length === 0) return 0;
  const sorted = [...buffer].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Drop single-poll spikes from index-count deltas and bulk-loader bursts. */
export function clampTelemetryRateSample(
  sample: number,
  buffer: number[],
  opts?: { maxAbsolute?: number; maxSpikeMultiplier?: number },
): number {
  const maxAbsolute = opts?.maxAbsolute ?? 150_000;
  let v = Number.isFinite(sample) && sample >= 0 ? sample : 0;
  v = Math.min(v, maxAbsolute);
  if (buffer.length >= 2) {
    const baseline = medianTelemetryRate(buffer);
    if (baseline > 0) {
      const cap = Math.max(
        baseline * (opts?.maxSpikeMultiplier ?? 3),
        baseline + 10_000,
      );
      if (v > cap) v = baseline;
    }
  }
  return v;
}

/** Prefer write-side rates over producer-side rates for the headline tile. */
export function pickBulkDisplayRps(
  ingestRps: number,
  indexDerivedRps: number,
  genRps: number,
): number {
  if (ingestRps > 0) return ingestRps;
  if (indexDerivedRps > 0) return indexDerivedRps;
  if (genRps > 0) return genRps;
  return 0;
}
