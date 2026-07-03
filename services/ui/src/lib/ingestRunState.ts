/** UI lifecycle for a single bulk ingest run on the Ingest page. */
export type RunUiPhase = "hidden" | "running" | "summary";

export const SUMMARY_VISIBLE_MS = 5_000;

export function monotonicWritten(previous: number, next: number): number {
  if (!Number.isFinite(next) || next < 0) return previous;
  if (!Number.isFinite(previous) || previous < 0) return next;
  return Math.max(previous, next);
}

export function shouldPollRun(phase: RunUiPhase): boolean {
  return phase === "running";
}

export function runUiPhaseForStatus(status: string): RunUiPhase {
  if (status === "running") return "running";
  if (status === "done" || status === "cancelled" || status === "error") return "summary";
  return "hidden";
}

export function shouldShowProgressCard(phase: RunUiPhase): boolean {
  return phase === "running" || phase === "summary";
}

export function formatRunSummary(written: number, elapsedMs: number): string {
  const rows = Number.isFinite(written) && written >= 0 ? written : 0;
  const sec = Math.max(1, Math.round((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
  return `Done — ${rows.toLocaleString("en-US")} rows in ${sec}s`;
}

export function elapsedMsSince(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, nowMs - t);
}

/** Monotonic bulk-ingest progress for UI display. */
export function pickBulkRunProgress(
  run: {
    rows_sent: number;
    rows_written?: number;
    rows_total: number;
    phase?: string;
  },
  previous: number = 0,
): number {
  const total = Number.isFinite(run.rows_total) && run.rows_total > 0 ? run.rows_total : 0;
  const sent = Math.max(0, run.rows_sent ?? 0);
  const written = typeof run.rows_written === "number" && Number.isFinite(run.rows_written) && run.rows_written >= 0
    ? run.rows_written
    : 0;

  const inWritingPhase = run.phase === "writing" || run.phase === "draining"
    || (total > 0 && sent >= total);

  let raw: number;
  if (inWritingPhase) {
    // Producers done — track Redis writes; fall back to sent if loader snapshot missed.
    raw = written > 0 ? written : sent;
  } else {
    // Producing — rows_sent is monotonic; rows_written can drop when loader probes miss replicas.
    raw = Math.max(sent, written);
  }

  if (total > 0) raw = Math.min(total, raw);
  return monotonicWritten(previous, raw);
}

/** Progress for the "Rows written" bar — phase-aware, monotonic, matches observability. */
export function effectiveRunWritten(
  run: {
    status: string;
    rows_total: number;
    rows_sent: number;
    rows_written: number;
    phase?: string;
    retries_total?: number;
  },
  monotonicFlushed: number,
): number {
  const total = Number.isFinite(run.rows_total) && run.rows_total > 0 ? run.rows_total : 0;
  const sent = Math.max(0, run.rows_sent ?? 0);
  const flushed = Math.max(0, monotonicFlushed);
  const retries = run.retries_total ?? 0;

  if (run.status === "done" && total > 0 && sent >= total) {
    return total;
  }

  if (run.status === "running") {
    if (sent === 0 && retries >= 5 && flushed === 0) {
      return 0;
    }
    return pickBulkRunProgress(
      { rows_sent: sent, rows_written: flushed, rows_total: total, phase: run.phase },
      flushed,
    );
  }

  const value = Math.max(flushed, sent);
  return total > 0 ? Math.min(total, value) : value;
}

/** Best row count for history / completion when flush delta lags producers. */
export function pickHistoryRowsWritten(
  bulk: { rows_total: number; rows_sent: number; rows_written?: number },
  uiWritten: number,
): number {
  const total = bulk.rows_total > 0 ? bulk.rows_total : 0;
  const sent = Math.max(0, bulk.rows_sent ?? 0);
  const flushed = Math.max(0, bulk.rows_written ?? 0);
  const value = Math.max(uiWritten, sent, flushed);
  return total > 0 ? Math.min(total, value) : value;
}

export function ingestStallHint(
  run: { status: string; retries_total?: number; throttled?: boolean },
  writeRps: number,
): string | null {
  if (run.status !== "running" || writeRps > 0) return null;
  const retries = run.retries_total ?? 0;
  if (retries >= 5) {
    return `Bulk-loader not accepting rows (${retries} retries) — try Stop all runs, then start again`;
  }
  if (run.throttled) return "Bulk-loader backpressure — slowing down";
  if (retries > 0) return "Waiting on bulk-loader…";
  return null;
}

/** Best live write-rate signal while a run is active. */
export function pickRunWriteRps(
  run: { status: string; rows_per_sec_write?: number; rows_per_sec_producer?: number },
  loaderFlushRps: number,
): number {
  if (run.status !== "running") return 0;
  return Math.max(
    loaderFlushRps,
    run.rows_per_sec_write ?? 0,
    run.rows_per_sec_producer ?? 0,
  );
}
