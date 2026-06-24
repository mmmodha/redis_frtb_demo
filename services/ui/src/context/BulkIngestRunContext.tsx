// Wave 7.0.8 — global bulk-loader ingest run state with localStorage reconnect.
// Mirrors GeneratorRunContext: survives page refresh and keeps polling while
// the operator navigates away from /ingest.

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
  getBulkLoadStatus,
  type BulkIngestStartResponse,
  type BulkIngestRunStatus,
  type BulkLoadStatus,
} from "../lib/ingest";
import {
  clearStoredBulkIngestRun,
  readStoredBulkIngestRun,
  writeStoredBulkIngestRun,
} from "../lib/bulkIngestState";
import {
  type BulkRunProgressBaseline,
  sumBulkLoaderFlushed,
} from "../lib/bulkIngestProgress";
import { clampTelemetryRateSample } from "../lib/telemetrySmoothing";

const POLL_MS = 1_000;
const TERMINAL_GRACE_MS = 30_000;
const RPS_WINDOW = 5;
/** Hide the progress bar shortly after cancel/error so the preset surface resets. */
const CANCELLED_UI_CLEAR_MS = 4_000;
/** Keep success visible slightly longer, then dismiss once the loader drains. */
const DONE_UI_CLEAR_MS = 5_000;

function pushRateSample(buf: number[], sample: number): number[] {
  const v = clampTelemetryRateSample(sample, buf);
  return [...buf, v].slice(-RPS_WINDOW);
}

function meanRate(buf: number[]): number {
  if (buf.length === 0) return 0;
  return buf.reduce((a, b) => a + b, 0) / buf.length;
}

function isTerminal(status: BulkIngestRunStatus["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

export interface BulkIngestRunContextValue {
  bulkRunId: string | null;
  bulkRun: BulkIngestRunStatus | null;
  bulkLoad: BulkLoadStatus | null;
  runBaseline: BulkRunProgressBaseline | null;
  smoothedGenRps: number;
  smoothedIngestRps: number;
  trackRun: (start: BulkIngestStartResponse, opts?: { indexCountAtStart?: number }) => void;
  cancelRun: () => void;
  clearRun: () => void;
}

export const BulkIngestRunContext = createContext<BulkIngestRunContextValue | null>(null);

export function BulkIngestRunProvider({ children }: { children: ReactNode }): JSX.Element {
  const [bulkRunId, setBulkRunId] = useState<string | null>(null);
  const [bulkRun, setBulkRun] = useState<BulkIngestRunStatus | null>(null);
  const [bulkLoad, setBulkLoad] = useState<BulkLoadStatus | null>(null);
  const [runBaseline, setRunBaseline] = useState<BulkRunProgressBaseline | null>(null);
  const [smoothedGenRps, setSmoothedGenRps] = useState(0);
  const [smoothedIngestRps, setSmoothedIngestRps] = useState(0);

  const genRpsBufferRef = useRef<number[]>([]);
  const ingestRpsBufferRef = useRef<number[]>([]);
  const lastIngestSampleRef = useRef<{ flushed: number; ms: number } | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writtenRunIdRef = useRef<string | null>(null);

  const resetRateBuffers = useCallback(() => {
    genRpsBufferRef.current = [];
    ingestRpsBufferRef.current = [];
    lastIngestSampleRef.current = null;
    setSmoothedGenRps(0);
    setSmoothedIngestRps(0);
  }, []);

  const clearRun = useCallback(() => {
    setBulkRunId(null);
    setBulkRun(null);
    setBulkLoad(null);
    setRunBaseline(null);
    resetRateBuffers();
    clearStoredBulkIngestRun();
    writtenRunIdRef.current = null;
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, [resetRateBuffers]);

  const trackRun = useCallback((start: BulkIngestStartResponse, opts?: { indexCountAtStart?: number }) => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    resetRateBuffers();
    const indexCountAtStart = typeof opts?.indexCountAtStart === "number"
      ? opts.indexCountAtStart
      : 0;
    const baseline: BulkRunProgressBaseline = {
      indexCountAtStart,
      flushedAtStart: null,
    };
    setRunBaseline(baseline);
    setBulkRunId(start.run_id);
    setBulkRun({
      run_id: start.run_id,
      status: "running",
      rows_total: start.rows_total,
      rows_sent: 0,
      rows_skipped: 0,
      batch_size: start.batch_size,
      concurrency: start.concurrency,
      workers: start.workers,
      ms: 0,
      started_at_iso: start.started_at_iso,
      bulk_loader_base: start.bulk_loader_base,
      rows_per_sec: 0,
    });
    writeStoredBulkIngestRun({
      run_id: start.run_id,
      rows_total: start.rows_total,
      started_at: Date.now(),
      workers: start.workers,
      index_count_at_start: indexCountAtStart,
    });
    writtenRunIdRef.current = start.run_id;
  }, [resetRateBuffers]);

  const cancelRun = useCallback(() => {
    if (!bulkRunId) return;
    resetRateBuffers();
    setBulkRun((prev) => (prev?.status === "running" ? { ...prev, status: "cancelling" } : prev));
    void cancelBulkIngest(bulkRunId).catch(() => { /* tolerated */ });
  }, [bulkRunId, resetRateBuffers]);

  useEffect(() => {
    if (!bulkRunId) return;
    let cancelled = false;
    let terminalSince: number | null = null;

    const tick = async (): Promise<void> => {
      try {
        const [r, s] = await Promise.all([
          getBulkIngestRun(bulkRunId),
          getBulkLoadStatus().catch(() => null),
        ]);
        if (cancelled) return;

        if (r === null) {
          clearRun();
          return;
        }

        setBulkRun((prev) => {
          if (prev?.status === "cancelling" && r.status === "running") return prev;
          return r;
        });
        if (s) {
          setBulkLoad(s);
          const totalFlushed = sumBulkLoaderFlushed(s);
          setRunBaseline((prev) => {
            if (!prev || prev.flushedAtStart !== null) return prev;
            const next: BulkRunProgressBaseline = { ...prev, flushedAtStart: totalFlushed };
            const stored = readStoredBulkIngestRun();
            if (stored?.run_id === bulkRunId) {
              writeStoredBulkIngestRun({ ...stored, flushed_at_start: totalFlushed });
            }
            return next;
          });
        }

        const live = r.status === "running";
        if (live) {
          const rawGen = typeof r.rows_per_sec === "number" && Number.isFinite(r.rows_per_sec)
            ? r.rows_per_sec
            : 0;
          genRpsBufferRef.current = pushRateSample(genRpsBufferRef.current, rawGen);
          setSmoothedGenRps(meanRate(genRpsBufferRef.current));

          if (s) {
            const totalFlushed = sumBulkLoaderFlushed(s);
            const elapsedMs = typeof r.ms === "number" ? r.ms : 0;
            const prevSample = lastIngestSampleRef.current;
            if (prevSample !== null) {
              const dMs = elapsedMs - prevSample.ms;
              const dFlushed = totalFlushed - prevSample.flushed;
              if (dMs >= 800 && dFlushed >= 0) {
                const rawIngest = (dFlushed * 1000) / dMs;
                ingestRpsBufferRef.current = pushRateSample(ingestRpsBufferRef.current, rawIngest);
                setSmoothedIngestRps(meanRate(ingestRpsBufferRef.current));
                lastIngestSampleRef.current = { flushed: totalFlushed, ms: elapsedMs };
              }
            } else {
              lastIngestSampleRef.current = { flushed: totalFlushed, ms: elapsedMs };
            }
          }
        } else if (isTerminal(r.status)) {
          resetRateBuffers();
        }

        const terminal = isTerminal(r.status);
        const drained = !s?.dispatcher || s.dispatcher.in_flight === 0;
        const clearing = r.status === "cancelled" || r.status === "error";
        const clearAfterMs = clearing ? CANCELLED_UI_CLEAR_MS : DONE_UI_CLEAR_MS;

        if (terminal) {
          if (graceTimerRef.current === null && writtenRunIdRef.current === bulkRunId) {
            graceTimerRef.current = setTimeout(() => {
              clearStoredBulkIngestRun();
              graceTimerRef.current = null;
              writtenRunIdRef.current = null;
            }, TERMINAL_GRACE_MS);
          }
          if (clearing || drained) {
            if (terminalSince === null) terminalSince = Date.now();
            if (Date.now() - terminalSince >= clearAfterMs) {
              clearRun();
              return;
            }
          } else {
            terminalSince = null;
          }
        } else {
          terminalSince = null;
          if (graceTimerRef.current) {
            clearTimeout(graceTimerRef.current);
            graceTimerRef.current = null;
          }
        }

        if (!cancelled) window.setTimeout(() => { void tick(); }, POLL_MS);
      } catch {
        if (!cancelled) window.setTimeout(() => { void tick(); }, POLL_MS);
      }
    };

    void tick();
    return () => { cancelled = true; };
  }, [bulkRunId, clearRun, resetRateBuffers]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let adoptedRunId: string | null = null;
      const stored = readStoredBulkIngestRun();
      if (stored?.run_id) {
        let status: BulkIngestRunStatus | null = null;
        try {
          status = await getBulkIngestRun(stored.run_id);
        } catch {
          status = null;
        }
        if (cancelled) return;
        if (status === null) {
          clearStoredBulkIngestRun();
        } else if (status.status === "running") {
          setBulkRunId(stored.run_id);
          setBulkRun(status);
          if (typeof stored.index_count_at_start === "number") {
            setRunBaseline({
              indexCountAtStart: stored.index_count_at_start,
              flushedAtStart: typeof stored.flushed_at_start === "number"
                ? stored.flushed_at_start
                : null,
            });
          }
          adoptedRunId = stored.run_id;
          writtenRunIdRef.current = stored.run_id;
        } else {
          setBulkRunId(stored.run_id);
          setBulkRun(status);
          if (typeof stored.index_count_at_start === "number") {
            setRunBaseline({
              indexCountAtStart: stored.index_count_at_start,
              flushedAtStart: typeof stored.flushed_at_start === "number"
                ? stored.flushed_at_start
                : null,
            });
          }
          graceTimerRef.current = setTimeout(() => {
            clearStoredBulkIngestRun();
            graceTimerRef.current = null;
          }, TERMINAL_GRACE_MS);
        }
      }

      let list: { active: { run_id: string; status: string; rows_sent: number; rows_total: number }[] } | null = null;
      try {
        list = await getActiveBulkIngestRuns();
      } catch {
        list = null;
      }
      if (cancelled) return;
      if (list?.active?.length && adoptedRunId === null) {
        const orphan = list.active[list.active.length - 1]!;
        if (orphan.status === "running") {
          writeStoredBulkIngestRun({
            run_id: orphan.run_id,
            rows_total: orphan.rows_total,
            started_at: Date.now(),
          });
          setBulkRunId(orphan.run_id);
          writtenRunIdRef.current = orphan.run_id;
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  return (
    <BulkIngestRunContext.Provider
      value={{
        bulkRunId,
        bulkRun,
        bulkLoad,
        runBaseline,
        smoothedGenRps,
        smoothedIngestRps,
        trackRun,
        cancelRun,
        clearRun,
      }}
    >
      {children}
    </BulkIngestRunContext.Provider>
  );
}

export function useBulkIngestRun(): BulkIngestRunContextValue {
  const ctx = useContext(BulkIngestRunContext);
  if (!ctx) {
    throw new Error("useBulkIngestRun must be used within a <BulkIngestRunProvider>");
  }
  return ctx;
}
