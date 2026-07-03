// Total SBM benchmark ladder — presentation timings at row-scale increments.

import { getActiveBulkIngestRuns, getIndexCount } from "./ingest";
import { getIngestRunHistory, type IngestRunHistoryEntry } from "./ingestRunHistory";
import { getCalcCoverage, type CalcCoverageResponse } from "./admin";
import { postCalcSbmTotal, type TotalSbmResponse } from "./calc";

/** Fixed portfolio scale steps for customer-facing benchmarks. */
export const BENCHMARK_ROW_TIERS = [
  10_000_000,
  50_000_000,
  100_000_000,
  200_000_000,
  400_000_000,
] as const;

export type BenchmarkStepStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  /** Shown for ladder rows below the current portfolio — needs a separate ingest. */
  | "skipped";

export interface BenchmarkStep {
  tier_rows: number;
  wall_ms: number | null;
  total_sbm: number | null;
  status: BenchmarkStepStatus;
  /** When false the row is display-only until ingest reaches that scale. */
  runnable: boolean;
  error?: string;
}

export interface PortfolioRowEstimate {
  rows: number;
  source: string;
}

export interface RollupPreflight {
  present: number;
  total: number;
  missing: number;
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

/** All presentation tiers at or below the snapped portfolio scale. */
export function benchmarkTiersUpTo(maxRows: number): number[] {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return [];
  return BENCHMARK_ROW_TIERS.filter((t) => t <= maxRows);
}

/** Largest fixed ladder label that fits the portfolio (e.g. 12M → 10M). */
export function snapPortfolioTier(rows: number): number | null {
  if (!Number.isFinite(rows) || rows <= 0) return null;
  let snapped: number | null = null;
  for (const t of BENCHMARK_ROW_TIERS) {
    if (t <= rows) snapped = t;
  }
  return snapped;
}

function latestCompletedIngestRun(runs: IngestRunHistoryEntry[]): IngestRunHistoryEntry | null {
  const done = runs.filter((r) => r.status === "done" && r.rows_written > 0);
  if (done.length === 0) return null;
  return done.sort((a, b) => b.ended_at_iso.localeCompare(a.ended_at_iso))[0] ?? null;
}

/** Build the display ladder; only the snapped/current tier is runnable on this cluster. */
export function buildBenchmarkPlan(portfolioRows: number): BenchmarkStep[] {
  if (!Number.isFinite(portfolioRows) || portfolioRows <= 0) return [];

  const snapped = snapPortfolioTier(portfolioRows);
  const runnableTier = snapped ?? portfolioRows;
  const tiers = snapped !== null
    ? benchmarkTiersUpTo(snapped)
    : [portfolioRows];

  return tiers.map((tier_rows) => ({
    tier_rows,
    wall_ms: null,
    total_sbm: null,
    status: tier_rows === runnableTier ? "pending" : "skipped",
    runnable: tier_rows === runnableTier,
  }));
}

export function runnableBenchmarkSteps(steps: BenchmarkStep[]): BenchmarkStep[] {
  return steps.filter((s) => s.runnable);
}

/**
 * Best-effort row count for the *current* portfolio. Uses the latest completed
 * bulk ingest (not the max across history) so a fresh 10M run is not masked by
 * an older 400M entry. DBSIZE is intentionally excluded — it counts all keys,
 * not sensitivity rows, and inflates the ladder.
 */
export async function estimatePortfolioRows(): Promise<PortfolioRowEstimate> {
  try {
    const { active } = await getActiveBulkIngestRuns();
    let bestActive = 0;
    for (const r of active) {
      const w = r.rows_written ?? 0;
      const sent = r.rows_sent ?? 0;
      const target = r.rows_total ?? 0;
      const candidate = w > 0 ? w : (sent > 0 ? sent : target);
      if (candidate > bestActive) bestActive = candidate;
    }
    if (bestActive > 0) {
      return { rows: bestActive, source: "active bulk ingest" };
    }
  } catch { /* fall through */ }

  try {
    const { runs } = await getIngestRunHistory();
    const latest = latestCompletedIngestRun(runs);
    if (latest) {
      return {
        rows: latest.rows_written,
        source: "latest completed ingest",
      };
    }
  } catch { /* fall through */ }

  try {
    const { count } = await getIndexCount();
    if (count > 0) {
      return { rows: count, source: "Redis index count (approx — run bulk ingest for exact)" };
    }
  } catch { /* fall through */ }

  return { rows: 0, source: "unknown" };
}

export async function fetchRollupPreflight(): Promise<RollupPreflight | null> {
  try {
    const cov: CalcCoverageResponse = await getCalcCoverage();
    return {
      present: cov.summary?.present ?? 0,
      total: cov.summary?.total ?? 0,
      missing: cov.summary?.missing ?? 0,
    };
  } catch {
    return null;
  }
}

export async function runTotalSbmBenchmarkCold(): Promise<TotalSbmResponse> {
  return postCalcSbmTotal({}, { nocache: true });
}
