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

/** Progress uses the best run-scoped signal: producer rows_sent or loader flush delta. */
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
    // Producers stalled on bulk-loader 503s — don't advance on stray flush deltas.
    if (sent === 0 && retries >= 5) {
      return 0;
    }
    const value = Math.max(sent, flushed);
    return total > 0 ? Math.min(total, value) : value;
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
