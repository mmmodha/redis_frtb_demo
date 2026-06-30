import { apiBase } from "./api";
import type { IngestRunHistoryEntry } from "./ingestRunHistoryDisplay";

export type { IngestRunHistoryEntry } from "./ingestRunHistoryDisplay";

const LOCAL_KEY = "frtb:ingest-run-history";
const LOCAL_MAX = 25;

export async function getIngestRunHistory(): Promise<{ runs: IngestRunHistoryEntry[] }> {
  const res = await fetch(`${apiBase()}/ingest/bulk/runs/history`);
  if (!res.ok) throw new Error(`api /ingest/bulk/runs/history ${res.status}`);
  return (await res.json()) as { runs: IngestRunHistoryEntry[] };
}

export async function getIngestRunHistoryEntry(runId: string): Promise<IngestRunHistoryEntry | null> {
  const res = await fetch(`${apiBase()}/ingest/bulk/runs/history/${encodeURIComponent(runId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`api /ingest/bulk/runs/history/${runId} ${res.status}`);
  return (await res.json()) as IngestRunHistoryEntry;
}

export function readLocalRunHistory(): IngestRunHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryEntry);
  } catch {
    return [];
  }
}

export function saveLocalRunHistoryEntry(entry: IngestRunHistoryEntry): void {
  const existing = readLocalRunHistory().filter((e) => e.run_id !== entry.run_id);
  existing.unshift(entry);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(existing.slice(0, LOCAL_MAX)));
}

export function mergeRunHistory(
  apiRuns: IngestRunHistoryEntry[],
  localRuns: IngestRunHistoryEntry[],
): IngestRunHistoryEntry[] {
  const byId = new Map<string, IngestRunHistoryEntry>();
  for (const r of localRuns) byId.set(r.run_id, r);
  for (const r of apiRuns) byId.set(r.run_id, r);
  return [...byId.values()].sort((a, b) => b.started_at_iso.localeCompare(a.started_at_iso));
}

function isHistoryEntry(v: unknown): v is IngestRunHistoryEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.run_id === "string"
    && typeof o.rows_written === "number"
    && typeof o.bulk_loader_base === "string";
}

export function entryFromCompletedRun(opts: {
  runId: string;
  status: "done" | "error" | "cancelled";
  rowsTotal: number;
  rowsWritten: number;
  rowsSent: number;
  durationMs: number;
  startedAtIso: string;
  bulkLoaderBase: string;
  workers: number;
  error?: string;
}): IngestRunHistoryEntry {
  const duration_ms = Math.max(0, Math.round(opts.durationMs));
  const avg = (rows: number) => (duration_ms > 0 ? Math.round((rows * 1000) / duration_ms) : 0);
  return {
    run_id: opts.runId,
    status: opts.status,
    rows_total: opts.rowsTotal,
    rows_sent: opts.rowsSent,
    rows_written: opts.rowsWritten,
    rows_skipped: 0,
    avg_producer_rps: avg(opts.rowsSent),
    avg_write_rps: avg(opts.rowsWritten),
    duration_ms,
    started_at_iso: opts.startedAtIso,
    ended_at_iso: new Date().toISOString(),
    bulk_loader_base: opts.bulkLoaderBase,
    workers: opts.workers,
    batch_size: 500,
    concurrency: 32,
    ...(opts.error ? { error: opts.error } : {}),
  };
}
