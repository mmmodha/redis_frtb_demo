// Global bulk-loader ingest run state with localStorage reconnect.
// Survives navigation away from /ingest and page refresh; keeps polling at app root.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  cancelBulkIngest,
  getActiveBulkIngestRuns,
  getBulkIngestRun,
  getIngestSnapshot,
  type IngestSnapshotRun,
} from "../lib/ingest";
import {
  clearStoredBulkIngestRun,
  readStoredBulkIngestRun,
  writeStoredBulkIngestRun,
} from "../lib/bulkIngestState";
import {
  monotonicWritten,
  shouldPollRun,
  runUiPhaseForStatus,
  SUMMARY_VISIBLE_MS,
  formatRunSummary,
  elapsedMsSince,
  effectiveRunWritten,
  pickRunWriteRps,
  ingestStallHint,
  type RunUiPhase,
} from "../lib/ingestRunState";

const RUN_POLL_MS = 1_000;

export interface IngestRunView {
  phase: RunUiPhase;
  runId: string | null;
  written: number;
  total: number;
  writeRps: number;
  stallHint: string | null;
  summaryText: string | null;
  keysAtRunStart: number | null;
}

export interface IngestRunContextValue {
  view: IngestRunView;
  beginRun: (
    runId: string,
    rowsTotal: number,
    startedAtIso: string,
    keysAtRunStart?: number,
  ) => void;
  cancelRun: () => Promise<void>;
}

const IngestRunContext = createContext<IngestRunContextValue | null>(null);

function snapshotRunFromBulk(
  run: NonNullable<Awaited<ReturnType<typeof getBulkIngestRun>>>,
): IngestSnapshotRun {
  return {
    run_id: run.run_id,
    status: run.status,
    rows_total: run.rows_total,
    rows_sent: run.rows_sent,
    rows_written: typeof run.rows_written === "number" ? run.rows_written : 0,
    rows_per_sec_producer: run.rows_per_sec_producer ?? run.rows_per_sec ?? 0,
    rows_per_sec_write: run.rows_per_sec_write ?? 0,
    phase: run.phase ?? "producing",
    workers: run.workers ?? 1,
    started_at_iso: run.started_at_iso,
    throttled: run.throttled,
    retries_total: run.retries_total,
    error: run.error,
  };
}

export function BulkIngestRunProvider({ children }: { children: ReactNode }): JSX.Element {
  const [phase, setPhase] = useState<RunUiPhase>("hidden");
  const [runId, setRunId] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [written, setWritten] = useState(0);
  const [writeRps, setWriteRps] = useState(0);
  const [stallHint, setStallHint] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [keysAtRunStart, setKeysAtRunStart] = useState<number | null>(null);

  const writtenRef = useRef(0);
  const startedAtRef = useRef<string | null>(null);
  const summaryScheduledRef = useRef(false);
  const pollGenRef = useRef(0);
  const adoptInflightRef = useRef(false);

  const resetRunState = useCallback(() => {
    setPhase("hidden");
    setRunId(null);
    setTotal(0);
    setWritten(0);
    setWriteRps(0);
    setStallHint(null);
    setSummaryText(null);
    setKeysAtRunStart(null);
    writtenRef.current = 0;
    startedAtRef.current = null;
    summaryScheduledRef.current = false;
    clearStoredBulkIngestRun();
  }, []);

  const scheduleSummary = useCallback((finalWritten: number) => {
    if (summaryScheduledRef.current) return;
    summaryScheduledRef.current = true;
    const elapsed = startedAtRef.current
      ? elapsedMsSince(startedAtRef.current, Date.now())
      : 0;
    setSummaryText(formatRunSummary(finalWritten, elapsed));
    setPhase("summary");
    window.setTimeout(() => {
      summaryScheduledRef.current = false;
      resetRunState();
    }, SUMMARY_VISIBLE_MS);
  }, [resetRunState]);

  const applyRun = useCallback((run: IngestSnapshotRun, loaderFlushRps: number) => {
    const monotonicFlushed = monotonicWritten(writtenRef.current, run.rows_written);
    const nextWritten = effectiveRunWritten(run, monotonicFlushed);
    // #region agent log
    fetch('http://127.0.0.1:7607/ingest/7ff27258-4498-4d23-9f58-aa9dac097748',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'fed362'},body:JSON.stringify({sessionId:'fed362',location:'BulkIngestRunContext.tsx:applyRun',message:'ingest bar progress tick',data:{runId:run.run_id,rows_sent:run.rows_sent,rows_written:run.rows_written,phase:run.phase,monotonicFlushed,nextWritten,prevWritten:writtenRef.current},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    writtenRef.current = nextWritten;
    setWritten(nextWritten);
    if (Number.isFinite(run.rows_total) && run.rows_total > 0) {
      setTotal(run.rows_total);
    }

    if (run.status === "running") {
      const rps = pickRunWriteRps(run, loaderFlushRps);
      setWriteRps(rps);
      setStallHint(ingestStallHint(run, rps));
      setPhase("running");
      return;
    }

    setWriteRps(0);
    setStallHint(null);
    if (runUiPhaseForStatus(run.status) === "summary") {
      scheduleSummary(nextWritten);
    }
  }, [scheduleSummary]);

  const phaseRef = useRef<RunUiPhase>("hidden");
  phaseRef.current = phase;
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;

  const poll = useCallback(async () => {
    const id = runIdRef.current;
    if (!id || !shouldPollRun(phaseRef.current)) return;
    const gen = ++pollGenRef.current;
    try {
      const snap = await getIngestSnapshot();
      if (gen !== pollGenRef.current) return;
      let run = snap.runs.find((r) => r.run_id === id);
      if (!run) {
        const bulk = await getBulkIngestRun(id);
        if (gen !== pollGenRef.current) return;
        if (!bulk) {
          // Tolerate transient API gaps — don't wipe progress on a single miss.
          return;
        }
        run = snapshotRunFromBulk(bulk);
      }
      const flushRps = run.status === "running" ? snap.loader.flush_rps : 0;
      applyRun(run, flushRps);
    } catch {
      /* tolerate transient poll errors */
    }
  }, [applyRun, resetRunState]);

  useEffect(() => {
    if (!shouldPollRun(phase) || !runId) return undefined;
    void poll();
    const id = window.setInterval(() => { void poll(); }, RUN_POLL_MS);
    return () => window.clearInterval(id);
  }, [phase, runId, poll]);

  const beginRun = useCallback((
    id: string,
    rowsTotal: number,
    started: string,
    keysBaseline?: number,
  ) => {
    summaryScheduledRef.current = false;
    writtenRef.current = 0;
    startedAtRef.current = started;
    setWritten(0);
    setWriteRps(0);
    setStallHint(null);
    setSummaryText(null);
    const keys = typeof keysBaseline === "number" ? keysBaseline : null;
    setKeysAtRunStart(keys);
    setRunId(id);
    setTotal(rowsTotal);
    setPhase("running");
    writeStoredBulkIngestRun({
      run_id: id,
      rows_total: rowsTotal,
      started_at: Date.now(),
      index_count_at_start: keys ?? undefined,
    });
  }, []);

  const cancelRun = useCallback(async () => {
    const id = runIdRef.current;
    if (!id) return;
    await cancelBulkIngest(id);
    await poll();
  }, [poll]);

  const adoptActiveRun = useCallback(async () => {
    if (phaseRef.current !== "hidden" || runIdRef.current || adoptInflightRef.current) return;
    adoptInflightRef.current = true;
    try {
      let targetId: string | null = null;
      let rowsTotal = 0;
      let startedIso = new Date().toISOString();
      let indexAtStart: number | undefined;

      const stored = readStoredBulkIngestRun();
      if (stored?.run_id) {
        targetId = stored.run_id;
        rowsTotal = stored.rows_total;
        indexAtStart = stored.index_count_at_start;
      } else {
        const list = await getActiveBulkIngestRuns().catch(() => null);
        const orphan = list?.active?.filter((r) => r.status === "running").at(-1);
        if (!orphan) return;
        targetId = orphan.run_id;
        rowsTotal = orphan.rows_total;
        startedIso = orphan.started_at_iso ?? startedIso;
        writeStoredBulkIngestRun({
          run_id: orphan.run_id,
          rows_total: orphan.rows_total,
          started_at: Date.now(),
        });
      }

      if (!targetId) return;

      const bulk = await getBulkIngestRun(targetId).catch(() => null);
      if (!bulk) {
        if (stored?.run_id === targetId) clearStoredBulkIngestRun();
        return;
      }
      if (bulk.status !== "running") {
        clearStoredBulkIngestRun();
        return;
      }

      summaryScheduledRef.current = false;
      startedAtRef.current = bulk.started_at_iso || startedIso;
      setRunId(targetId);
      setTotal(rowsTotal || bulk.rows_total);
      setPhase("running");
      setWriteRps(0);
      setStallHint(null);
      setSummaryText(null);
      if (typeof indexAtStart === "number") {
        setKeysAtRunStart(indexAtStart);
      }

      const run = snapshotRunFromBulk(bulk);
      const nextWritten = effectiveRunWritten(run, run.rows_written);
      writtenRef.current = nextWritten;
      setWritten(nextWritten);
    } finally {
      adoptInflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void adoptActiveRun();
  }, [adoptActiveRun]);

  useEffect(() => {
    if (phase !== "hidden" || runId) return undefined;
    const id = window.setInterval(() => { void adoptActiveRun(); }, 2_000);
    return () => window.clearInterval(id);
  }, [phase, runId, adoptActiveRun]);

  const value: IngestRunContextValue = {
    view: {
      phase,
      runId,
      written,
      total,
      writeRps,
      stallHint,
      summaryText,
      keysAtRunStart,
    },
    beginRun,
    cancelRun,
  };

  return (
    <IngestRunContext.Provider value={value}>
      {children}
    </IngestRunContext.Provider>
  );
}

export function useIngestRun(): IngestRunContextValue {
  const ctx = useContext(IngestRunContext);
  if (!ctx) {
    throw new Error("useIngestRun must be used within a <BulkIngestRunProvider>");
  }
  return ctx;
}

/** @deprecated Use useIngestRun — kept for legacy tests and adapters. */
export interface BulkIngestRunContextValue {
  bulkRunId: string | null;
  bulkRun: { run_id: string; status: string; rows_sent: number; rows_total: number } | null;
  cancelRun: () => void;
}

export function useBulkIngestRun(): BulkIngestRunContextValue {
  const { view, cancelRun } = useIngestRun();
  const status = view.phase === "running"
    ? "running"
    : view.phase === "summary"
      ? "done"
      : "";
  return {
    bulkRunId: view.runId,
    bulkRun: view.runId
      ? {
        run_id: view.runId,
        status,
        rows_sent: view.written,
        rows_total: view.total,
      }
      : null,
    cancelRun: () => { void cancelRun(); },
  };
}
