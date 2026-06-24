// Wave 7.0.8 — localStorage persistence for bulk-loader ingest runs so a page
// refresh can reconnect to GET /ingest/bulk/runs/:id and restore progress.

export const BULK_INGEST_STORAGE_KEY = "bulk-ingest-active-run";

export interface StoredBulkIngestRun {
  run_id: string;
  rows_total: number;
  started_at: number;
  workers?: number;
  index_count_at_start?: number;
  flushed_at_start?: number;
}

export function readStoredBulkIngestRun(): StoredBulkIngestRun | null {
  try {
    const raw = localStorage.getItem(BULK_INGEST_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredBulkIngestRun>;
    if (typeof parsed?.run_id !== "string") return null;
    return {
      run_id: parsed.run_id,
      rows_total: typeof parsed.rows_total === "number" ? parsed.rows_total : 0,
      started_at: typeof parsed.started_at === "number" ? parsed.started_at : Date.now(),
      workers: typeof parsed.workers === "number" ? parsed.workers : undefined,
      index_count_at_start: typeof parsed.index_count_at_start === "number"
        ? parsed.index_count_at_start
        : undefined,
      flushed_at_start: typeof parsed.flushed_at_start === "number"
        ? parsed.flushed_at_start
        : undefined,
    };
  } catch {
    return null;
  }
}

export function writeStoredBulkIngestRun(s: StoredBulkIngestRun): void {
  try {
    localStorage.setItem(BULK_INGEST_STORAGE_KEY, JSON.stringify(s));
  } catch { /* noop */ }
}

export function clearStoredBulkIngestRun(): void {
  try {
    localStorage.removeItem(BULK_INGEST_STORAGE_KEY);
  } catch { /* noop */ }
}
