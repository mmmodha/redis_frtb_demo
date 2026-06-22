// Wave 7.0.4.B — pure deviation calculation for the per-shard panel.
//
// Highlights any shard whose value for the given metric deviates from the
// cluster MEAN by more than `threshold` (fraction, default 0.10 = 10%).
// Splitting the math out keeps the panel render trivially testable and
// avoids coupling a future alerting wave to React's render tree.
//
// Decisions:
//   * Null / non-finite samples are excluded from the mean and never flagged.
//     A shard that lost its `write_ops_per_sec` for one tick should NOT
//     trigger a deviation flash on the next tick when the value reappears.
//   * Mean of zero (every shard idle) yields zero flags; a 0-vs-0 comparison
//     has no meaningful "deviation".
//   * Fewer than 2 shards yields zero flags — there is no cluster to deviate
//     from when you have one node.
//   * Strict greater-than (`>`) on the threshold — a shard exactly at 10%
//     does not flash, matching the spec wording "deviates >10%".

import type { PerShardRow } from "./api";

export type DeviationMetric =
  | "memory_used"
  | "key_count"
  | "write_ops_per_sec"
  | "index_lag";

export const DEFAULT_DEVIATION_THRESHOLD = 0.10;

function sampleFor(row: PerShardRow, metric: DeviationMetric): number | null {
  const v = row[metric];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Returns the set of `shard_id`s whose `metric` sample deviates from the
// cluster mean by more than `threshold`. Mean is computed over rows that
// contributed a finite sample for that metric.
export function computeShardDeviationFlags(
  rows: readonly PerShardRow[],
  metric: DeviationMetric,
  threshold: number = DEFAULT_DEVIATION_THRESHOLD,
): Set<string> {
  const flags = new Set<string>();
  if (!Array.isArray(rows) || rows.length < 2) return flags;
  const samples: Array<{ id: string; v: number }> = [];
  for (const r of rows) {
    if (!r || typeof r.shard_id !== "string") continue;
    if (r.degraded) continue;
    const v = sampleFor(r, metric);
    if (v === null) continue;
    samples.push({ id: r.shard_id, v });
  }
  if (samples.length < 2) return flags;
  const sum = samples.reduce((acc, s) => acc + s.v, 0);
  const mean = sum / samples.length;
  if (mean === 0) return flags;
  const denom = Math.abs(mean);
  for (const s of samples) {
    const dev = Math.abs(s.v - mean) / denom;
    if (dev > threshold) flags.add(s.id);
  }
  return flags;
}

// Convenience: returns the per-shard deviation ratios (signed) for tooltip
// rendering — `(value - mean) / |mean|`. Same skip semantics as the flag
// computation so the ratio map and the flag set agree on which shards are
// "in scope".
export function computeShardDeviationRatios(
  rows: readonly PerShardRow[],
  metric: DeviationMetric,
): Map<string, number> {
  const ratios = new Map<string, number>();
  if (!Array.isArray(rows) || rows.length < 2) return ratios;
  const samples: Array<{ id: string; v: number }> = [];
  for (const r of rows) {
    if (!r || typeof r.shard_id !== "string") continue;
    if (r.degraded) continue;
    const v = sampleFor(r, metric);
    if (v === null) continue;
    samples.push({ id: r.shard_id, v });
  }
  if (samples.length < 2) return ratios;
  const sum = samples.reduce((acc, s) => acc + s.v, 0);
  const mean = sum / samples.length;
  if (mean === 0) return ratios;
  const denom = Math.abs(mean);
  for (const s of samples) {
    ratios.set(s.id, (s.v - mean) / denom);
  }
  return ratios;
}
