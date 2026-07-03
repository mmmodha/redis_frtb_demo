// Total SBM benchmark ladder — presentation timings at row-scale increments.

import { apiBase } from "./api";
import { getActiveBulkIngestRuns } from "./ingest";
import { getIngestRunHistory, type IngestRunHistoryEntry } from "./ingestRunHistory";
import type { CalcCoverageResponse } from "./admin";
import { postCalcSbmTotal, type TotalSbmResponse } from "./calc";

const PORTFOLIO_FETCH_TIMEOUT_MS = 15_000;
const ROLLUP_PREFLIGHT_TIMEOUT_MS = 8_000;

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

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
  | "skipped";

export interface BucketCell {
  risk_class: string;
  bucket: string;
}

export interface BucketFacetRow {
  risk_class: string;
  bucket: string;
  count: number;
}

export interface BenchmarkStep {
  tier_rows: number;
  wall_ms: number | null;
  total_sbm: number | null;
  status: BenchmarkStepStatus;
  runnable: boolean;
  /** Empty = full portfolio; non-empty = bucket subset for this tier. */
  bucket_cells: BucketCell[];
  /** Approximate row count covered by bucket_cells. */
  subset_rows: number | null;
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

export interface BucketFacetFetch {
  buckets: BucketFacetRow[];
  approximate: boolean;
}

export interface BucketSubsetSelection {
  cells: BucketCell[];
  selectedRows: number;
  isFull: boolean;
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

/**
 * Sum of per-bucket row counts — best sensitivity-row total for subset sizing.
 */
export function totalRowsFromBucketFacets(facets: BucketFacetRow[]): number {
  let total = 0;
  for (const f of facets) {
    if (f.count > 0) total += f.count;
  }
  return total;
}

/** Prefer facet sum over DBSIZE / key-count when bucket facets are available. */
export function resolveBenchmarkPortfolioRows(
  est: PortfolioRowEstimate,
  bucketFacets: BucketFacetRow[],
): PortfolioRowEstimate {
  const facetTotal = totalRowsFromBucketFacets(bucketFacets);
  if (facetTotal <= 0) return est;
  return {
    rows: facetTotal,
    source: "bucket facets (sum of counts)",
  };
}

function sortBucketsForSubset(facets: BucketFacetRow[]): BucketFacetRow[] {
  return [...facets]
    .filter((f) => f.count > 0)
    .sort((a, b) => {
      if (a.count !== b.count) return a.count - b.count;
      const rc = a.risk_class.localeCompare(b.risk_class);
      return rc !== 0 ? rc : a.bucket.localeCompare(b.bucket);
    });
}

function bucketCountsAreUniform(facets: BucketFacetRow[]): boolean {
  if (facets.length <= 1) return true;
  const first = facets[0]!.count;
  return facets.every((f) => f.count === first);
}

export interface BucketSubsetOptions {
  /** 0-based ladder index (10M → 0). */
  tierIndex?: number;
  tierCount?: number;
  /** Scale subset by tier position when facet row counts are uniform estimates. */
  proportionalByTier?: boolean;
}

/**
 * Pick buckets for a target row count. Uses row-sum greedy when counts vary;
 * when counts are uniform (seen-bucket fallback), scales by ladder position
 * so 10M/50M/100M tiers fan out to different bucket counts and wall times differ.
 */
export function selectBucketCellsForTarget(
  facets: BucketFacetRow[],
  targetRows: number,
  opts: BucketSubsetOptions = {},
): BucketSubsetSelection {
  const sorted = sortBucketsForSubset(facets);

  let totalRows = 0;
  for (const f of sorted) totalRows += f.count;

  if (sorted.length === 0 || targetRows >= totalRows) {
    return { cells: [], selectedRows: totalRows, isFull: true };
  }

  const useProportional = opts.proportionalByTier === true
    || bucketCountsAreUniform(sorted);

  if (
    useProportional
    && opts.tierIndex != null
    && opts.tierCount != null
    && opts.tierCount > 0
  ) {
    const nBuckets = Math.max(
      1,
      Math.min(
        sorted.length,
        Math.ceil(((opts.tierIndex + 1) / opts.tierCount) * sorted.length),
      ),
    );
    if (nBuckets >= sorted.length) {
      return { cells: [], selectedRows: totalRows, isFull: true };
    }
    const picked = sorted.slice(0, nBuckets);
    const selectedRows = picked.reduce((s, f) => s + f.count, 0);
    return {
      cells: picked.map((f) => ({ risk_class: f.risk_class, bucket: f.bucket })),
      selectedRows,
      isFull: false,
    };
  }

  const cells: BucketCell[] = [];
  let selectedRows = 0;
  for (const f of sorted) {
    cells.push({ risk_class: f.risk_class, bucket: f.bucket });
    selectedRows += f.count;
    if (selectedRows >= targetRows) break;
  }

  return { cells, selectedRows, isFull: false };
}

/** Build ladder steps; each tier runs a cold Total SBM on a bucket subset. */
export function buildBenchmarkPlan(
  portfolioRows: number,
  bucketFacets: BucketFacetRow[],
  opts?: { bucketCountsApproximate?: boolean },
): BenchmarkStep[] {
  if (!Number.isFinite(portfolioRows) || portfolioRows <= 0) return [];

  const snapped = snapPortfolioTier(portfolioRows);
  const tiers = snapped !== null
    ? benchmarkTiersUpTo(snapped)
    : [portfolioRows];

  const hasFacets = bucketFacets.length > 0;

  const proportional = opts?.bucketCountsApproximate === true
    || bucketCountsAreUniform(bucketFacets);

  return tiers.map((tier_rows, tierIndex) => {
    if (tier_rows > portfolioRows) {
      return {
        tier_rows,
        wall_ms: null,
        total_sbm: null,
        status: "skipped" as const,
        runnable: false,
        bucket_cells: [],
        subset_rows: null,
      };
    }

    if (!hasFacets) {
      const onlyTop = tier_rows === (snapped ?? portfolioRows);
      return {
        tier_rows,
        wall_ms: null,
        total_sbm: null,
        status: onlyTop ? "pending" as const : "skipped" as const,
        runnable: onlyTop,
        bucket_cells: [],
        subset_rows: onlyTop ? portfolioRows : null,
      };
    }

    const { cells, selectedRows, isFull } = selectBucketCellsForTarget(
      bucketFacets,
      tier_rows,
      {
        tierIndex,
        tierCount: tiers.length,
        proportionalByTier: proportional,
      },
    );
    return {
      tier_rows,
      wall_ms: null,
      total_sbm: null,
      status: "pending" as const,
      runnable: true,
      bucket_cells: isFull ? [] : cells,
      subset_rows: selectedRows,
    };
  });
}

export function runnableBenchmarkSteps(steps: BenchmarkStep[]): BenchmarkStep[] {
  return steps.filter((s) => s.runnable);
}

export async function fetchBucketFacetsForBenchmark(): Promise<BucketFacetFetch> {
  try {
    const body = await fetchJsonWithTimeout<{
      ok?: boolean;
      buckets?: BucketFacetRow[];
      approximate?: boolean;
    }>(
      `${apiBase()}/facets/bucket?refresh=1`,
      PORTFOLIO_FETCH_TIMEOUT_MS,
    );
    if (!Array.isArray(body.buckets)) return { buckets: [], approximate: false };
    const buckets = body.buckets.filter(
      (b) => typeof b.risk_class === "string"
        && typeof b.bucket === "string"
        && typeof b.count === "number"
        && b.count > 0,
    );
    return { buckets, approximate: body.approximate === true };
  } catch {
    return { buckets: [], approximate: false };
  }
}

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
    const facets = await fetchJsonWithTimeout<{ ok?: boolean; total_rows?: number }>(
      `${apiBase()}/facets`,
      PORTFOLIO_FETCH_TIMEOUT_MS,
    );
    if (facets.ok === true && typeof facets.total_rows === "number" && facets.total_rows > 0) {
      return { rows: facets.total_rows, source: "sensitivity index (facets)" };
    }
  } catch { /* fall through */ }

  try {
    const body = await fetchJsonWithTimeout<{ count?: number }>(
      `${apiBase()}/admin/index-count`,
      PORTFOLIO_FETCH_TIMEOUT_MS,
    );
    const count = typeof body.count === "number" && body.count > 0 ? body.count : 0;
    if (count > 0) {
      return { rows: count, source: "Redis key count (approx)" };
    }
  } catch { /* fall through */ }

  return { rows: 0, source: "unknown" };
}

export async function fetchRollupPreflight(
  timeoutMs = ROLLUP_PREFLIGHT_TIMEOUT_MS,
): Promise<RollupPreflight | null> {
  try {
    const cov = await fetchJsonWithTimeout<CalcCoverageResponse>(
      `${apiBase()}/admin/calc-coverage`,
      timeoutMs,
    );
    return {
      present: cov.summary?.present ?? 0,
      total: cov.summary?.total ?? 0,
      missing: cov.summary?.missing ?? 0,
    };
  } catch {
    return null;
  }
}

export async function runTotalSbmBenchmarkCold(
  bucketCells: BucketCell[] = [],
): Promise<TotalSbmResponse> {
  const body = bucketCells.length > 0 ? { bucket_cells: bucketCells } : {};
  return postCalcSbmTotal(body, { nocache: true });
}
