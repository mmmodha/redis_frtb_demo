import {
  createBulkLoaderStatusFetch,
  discoverBulkLoaderTopology,
  fetchAggregatedBulkLoadStatus,
  sumFlushed,
} from "../bulk-loader-topology.ts";
import { computeRowsWritten } from "../routes/ingest-snapshot.ts";

export interface BulkRunHistorySource {
  run_id: string;
  status: "done" | "error" | "cancelled";
  rows_total: number;
  rows_sent: number;
  rows_skipped: number;
  batch_size: number;
  concurrency: number;
  workers: number;
  started_at_iso: string;
  ms: number;
  bulk_loader_base: string;
  flushed_at_start: number | null;
  error?: string;
}

export interface IngestRunHistoryEntry {
  run_id: string;
  status: "done" | "error" | "cancelled";
  rows_total: number;
  rows_sent: number;
  rows_written: number;
  rows_skipped: number;
  avg_producer_rps: number;
  avg_write_rps: number;
  duration_ms: number;
  started_at_iso: string;
  ended_at_iso: string;
  bulk_loader_base: string;
  workers: number;
  batch_size: number;
  concurrency: number;
  error?: string;
}

const MAX_HISTORY = 25;
const history: IngestRunHistoryEntry[] = [];

export function avgRps(rows: number, durationMs: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round((rows * 1000) / durationMs);
}

export function buildHistoryEntry(
  record: BulkRunHistorySource,
  rows_written: number,
  endedAtIso: string,
): IngestRunHistoryEntry {
  const duration_ms = Math.max(0, Math.round(record.ms));
  const written = Math.min(
    record.rows_total,
    Math.max(0, Number.isFinite(rows_written) ? rows_written : 0),
  );
  return {
    run_id: record.run_id,
    status: record.status,
    rows_total: record.rows_total,
    rows_sent: record.rows_sent,
    rows_written: written,
    rows_skipped: record.rows_skipped,
    avg_producer_rps: avgRps(record.rows_sent, duration_ms),
    avg_write_rps: avgRps(written, duration_ms),
    duration_ms,
    started_at_iso: record.started_at_iso,
    ended_at_iso: endedAtIso,
    bulk_loader_base: record.bulk_loader_base,
    workers: record.workers,
    batch_size: record.batch_size,
    concurrency: record.concurrency,
    ...(record.error ? { error: record.error } : {}),
  };
}

export function pushRunHistory(entry: IngestRunHistoryEntry): void {
  const idx = history.findIndex((h) => h.run_id === entry.run_id);
  if (idx >= 0) history.splice(idx, 1);
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

export function listRunHistory(): IngestRunHistoryEntry[] {
  return [...history];
}

export function getRunHistoryEntry(run_id: string): IngestRunHistoryEntry | undefined {
  return history.find((h) => h.run_id === run_id);
}

export function _testResetRunHistory(): void {
  history.length = 0;
}

export async function archiveBulkRunHistory(
  record: BulkRunHistorySource,
  deps: { bulkBase: string; fetchImpl?: typeof fetch },
): Promise<IngestRunHistoryEntry> {
  let rows_written = record.rows_sent;
  if (record.flushed_at_start != null) {
    try {
      const fetchOne = createBulkLoaderStatusFetch({
        base: deps.bulkBase,
        fetchImpl: deps.fetchImpl,
      });
      const topo = await discoverBulkLoaderTopology(fetchOne);
      const agg = await fetchAggregatedBulkLoadStatus(fetchOne, topo.replicas);
      rows_written = computeRowsWritten(sumFlushed(agg), record.flushed_at_start);
    } catch {
      /* fall back to rows_sent */
    }
  }
  rows_written = Math.min(
    record.rows_total,
    Math.max(rows_written, record.rows_sent),
  );
  const endedAtIso = new Date().toISOString();
  const entry = buildHistoryEntry(record, rows_written, endedAtIso);
  pushRunHistory(entry);
  return entry;
}
