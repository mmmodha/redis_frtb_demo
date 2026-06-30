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

export function formatDurationMs(ms: number): string {
  const sec = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export function formatEndpoint(base: string): string {
  try {
    const u = new URL(base);
    return u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return base;
  }
}

export function formatStartedAt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatStartedAtTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function localDateKeyFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatHistoryDateGroupLabel(dateKey: string, now = new Date()): string {
  if (dateKey === "unknown") return "Unknown date";
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return dateKey;
  const groupDate = new Date(y, m - 1, d);
  const todayKey = localDateKeyFromIso(now.toISOString());
  if (dateKey === todayKey) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === localDateKeyFromIso(yesterday.toISOString())) return "Yesterday";
  return groupDate.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: groupDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export interface IngestRunHistoryDateGroup {
  dateKey: string;
  label: string;
  runs: IngestRunHistoryEntry[];
}

export function groupIngestRunsByDate(
  runs: IngestRunHistoryEntry[],
  now = new Date(),
): IngestRunHistoryDateGroup[] {
  const byDate = new Map<string, IngestRunHistoryEntry[]>();
  for (const run of runs) {
    const key = localDateKeyFromIso(run.started_at_iso);
    const bucket = byDate.get(key);
    if (bucket) bucket.push(run);
    else byDate.set(key, [run]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, groupRuns]) => ({
      dateKey,
      label: formatHistoryDateGroupLabel(dateKey, now),
      runs: groupRuns,
    }));
}

export function statusLabel(status: IngestRunHistoryEntry["status"]): string {
  switch (status) {
    case "done": return "Completed";
    case "cancelled": return "Cancelled";
    case "error": return "Failed";
  }
}

export function statusClass(status: IngestRunHistoryEntry["status"]): string {
  return `ingest-history__status ingest-history__status--${status}`;
}
