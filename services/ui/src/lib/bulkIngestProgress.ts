// Wave 7.0.8 — run-scoped bulk ingest progress. Index count and bulk-loader
// flushed counters are cumulative across runs; progress must use deltas from
// baselines captured at run start (mirrors IndexingAnchor).

export interface BulkRunProgressBaseline {
  indexCountAtStart: number;
  flushedAtStart: number | null;
}

export function sumBulkLoaderFlushed(load: { workers?: Array<{ flushed?: number | null }> } | null): number {
  return (load?.workers ?? []).reduce((a, w) => a + (w.flushed ?? 0), 0);
}

export function computeBulkRunDone(params: {
  rowsTotal: number;
  rowsSent: number;
  baseline: BulkRunProgressBaseline | null;
  totalFlushed: number;
}): number {
  const { rowsTotal, rowsSent, baseline, totalFlushed } = params;
  if (!Number.isFinite(rowsTotal) || rowsTotal <= 0) return 0;

  const flushedDelta = baseline !== null && baseline.flushedAtStart !== null
    ? Math.max(0, totalFlushed - baseline.flushedAtStart)
    : 0;

  // rows_sent is run-scoped from the api; loader flush delta is anchored.
  return Math.min(rowsTotal, Math.max(0, rowsSent, flushedDelta));
}
