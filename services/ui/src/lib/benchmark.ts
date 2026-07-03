// Total SBM benchmark ladder — presentation timings at row-scale increments.

import { getActiveBulkIngestRuns, getIndexCount } from "./ingest";
import { getIngestRunHistory } from "./ingestRunHistory";
import { postCalcSbmTotal, type TotalSbmResponse } from "./calc";

/** Fixed portfolio scale steps for customer-facing benchmarks. */
export const BENCHMARK_ROW_TIERS = [
  10_000_000,
  50_000_000,
  100_000_000,
  200_000_000,
  400_000_000,
] as const;

export type BenchmarkStepStatus = "pending" | "running" | "done" | "error";

export interface BenchmarkStep {
  tier_rows: number;
  wall_ms: number | null;
  total_sbm: number | null;
  status: BenchmarkStepStatus;
  error?: string;
}

export interface PortfolioRowEstimate {
  rows: number;
  source: string;
}

export function formatBenchmarkRows(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export function formatBenchmarkWallMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

/** Ladder tiers at or below the detected portfolio size. */
export function benchmarkTiersUpTo(maxRows: number): number[] {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return [];
  return BENCHMARK_ROW_TIERS.filter((t) => t <= maxRows);
}

export function initialBenchmarkSteps(tiers: number[]): BenchmarkStep[] {
  return tiers.map((tier_rows) => ({
    tier_rows,
    wall_ms: null,
    total_sbm: null,
    status: "pending",
  }));
}

function maxRowCount(values: number[]): number {
  let best = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > best) best = v;
  }
  return best;
}

/** Best-effort row count for ladder capping (ingest history → active run → DBSIZE). */
export async function estimatePortfolioRows(): Promise<PortfolioRowEstimate> {
  try {
    const { active } = await getActiveBulkIngestRuns();
    const fromActive = maxRowCount(
      active.flatMap((r) => [r.rows_written ?? 0, r.rows_sent, r.rows_total]),
    );
    if (fromActive > 0) {
      return { rows: fromActive, source: "active bulk ingest" };
    }
  } catch { /* fall through */ }

  try {
    const { runs } = await getIngestRunHistory();
    const fromHistory = maxRowCount(
      runs.flatMap((r) => [r.rows_written, r.rows_total]),
    );
    if (fromHistory > 0) {
      return { rows: fromHistory, source: "ingest history" };
    }
  } catch { /* fall through */ }

  try {
    const ic = await getIndexCount();
    if (ic.count > 0) {
      return { rows: ic.count, source: "index key count (approx)" };
    }
  } catch { /* fall through */ }

  return { rows: 0, source: "unknown" };
}

export async function runTotalSbmBenchmarkCold(): Promise<TotalSbmResponse> {
  return postCalcSbmTotal({}, { nocache: true });
}
