// Wave 5.38a — global synthetic generator run state.
//
// The streaming generator run used to live inside SyntheticGeneratorCard;
// unmounting IngestPanel (e.g. navigating to /calc) abandoned the in-flight
// SSE stream and dropped its progress UI. Lifting the run state +
// GeneratorStreamHandle into a provider that sits above <Routes> keeps the
// run alive across route changes, and lets AppShell render a nav pill from
// any route. Modelled on PivotBurstContext (Wave 5.21g).
//
// Wave 5.40b — refresh-survival. On mount the provider checks
// localStorage("generator-active-run") and GET /generator/runs (orphan
// discovery), then falls into a polling loop against
// GET /generator/runs/:id/status so the progress bar + Cancel button reappear
// after the user reloads the tab. Polling and SSE are mutually exclusive.

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
  cancelGenerator,
  getActiveGeneratorRuns,
  getGeneratorRunStatus,
  startGeneratorStream,
  type GeneratorConfig,
  type GeneratorRunStatus,
  type GeneratorStreamHandle,
  type ProgressFrame,
  type StopReason,
  type TerminalFrame,
} from "../lib/ingest";

// Default row count when the caller posts an empty body (cfg === null);
// matches services/api/src/routes/generator.ts DEFAULT_ROWS.
const DEFAULT_GEN_ROWS = 200;

// Wave 5.40b — localStorage key + cadence + grace window for the reconnect
// loop. The server already keeps terminal runs queryable for
// `terminalGraceMs` (30s by default — see services/api/src/routes/generator.ts);
// the client mirrors that so a refresh just-after-completion still surfaces
// the "done" summary before the entry disappears.
const STORAGE_KEY = "generator-active-run";
const POLL_INTERVAL_MS = 500;
const TERMINAL_GRACE_MS = 30_000;

// Wave 5.56 — broadcast that /facets is stale so PivotPanel / CalcPanel /
// JsonExplorerPanel re-fetch their dropdown counts as soon as the generator
// (any path: SSE terminal frame, SSE error, post-refresh polling) reaches
// a terminal state. The event is best-effort — no-op when window is
// undefined (SSR / Node test harness without a DOM).
function dispatchFacetsStale(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("frtb:facets-stale"));
  } catch {
    // best-effort; ignore environments without CustomEvent support
  }
}

// Wave 5.45 — auto-dismiss windows for the nav pill / terminal summary so
// the bar disappears on its own after a run completes. Exported for tests.
export const AUTO_DISMISS_DONE_MS = 6_000;
export const AUTO_DISMISS_ERROR_MS = 12_000;

export interface GeneratorRunState {
  rowsTotal: number;
  rowsDone: number;
  elapsedMs: number;
  rowsPerSec: number;
  runId: string | null;
  status: "running" | "cancelling" | "done" | "cancelled" | "error";
  terminalMs?: number;
  // Wave 5.47c — which stop condition halted the run, when known. Surfaced
  // by the SSE terminal frame and by /generator/runs/:id/status on a
  // post-refresh reconnect.
  stopReason?: StopReason;
}

export interface GeneratorRunContextValue {
  run: GeneratorRunState | null;
  error: string | null;
  startRun: (cfg: GeneratorConfig | null) => void;
  cancelRun: () => void;
  clearRun: () => void;
}

export const GeneratorRunContext = createContext<GeneratorRunContextValue | null>(null);

interface StoredRun {
  run_id: string;
  rows_total: number;
  started_at: number;
}

function readStored(): StoredRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRun>;
    if (typeof parsed?.run_id === "string") {
      return {
        run_id: parsed.run_id,
        rows_total: typeof parsed.rows_total === "number" ? parsed.rows_total : 0,
        started_at: typeof parsed.started_at === "number" ? parsed.started_at : Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStored(s: StoredRun): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* noop */ }
}

function clearStored(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
}

function isTerminalStatus(s: GeneratorRunStatus["status"]): boolean {
  return s === "done" || s === "cancelled" || s === "error";
}

function statusToRunState(s: GeneratorRunStatus): GeneratorRunState {
  const mapped: GeneratorRunState["status"] = s.status === "running"
    ? "running"
    : s.status === "cancelled"
      ? "cancelled"
      : s.status === "error"
        ? "error"
        : "done";
  return {
    rowsTotal: s.rows_total,
    rowsDone: s.rows_done,
    elapsedMs: s.elapsed_ms,
    rowsPerSec: s.rows_per_sec,
    runId: s.run_id,
    status: mapped,
    terminalMs: isTerminalStatus(s.status) ? s.elapsed_ms : undefined,
    stopReason: s.stop_reason,
  };
}

export function GeneratorRunProvider({ children }: { children: ReactNode }): JSX.Element {
  const [run, setRun] = useState<GeneratorRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<GeneratorStreamHandle | null>(null);
  // Wave 5.40b — polling-mode reconnect state. `pollRef` holds the active
  // interval id plus the run_id being polled; `graceTimerRef` holds the
  // post-terminal cleanup timer for the localStorage entry; `writtenRunIdRef`
  // debounces the localStorage write so we only do it once per SSE run.
  const pollRef = useRef<{ runId: string; interval: ReturnType<typeof setInterval> } | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writtenRunIdRef = useRef<string | null>(null);
  // Wave 5.45 — auto-dismiss timer for the terminal summary. Cleared by
  // startRun (so a new run renders immediately) and by unmount.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current.interval);
      pollRef.current = null;
    }
  }, []);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const scheduleDismiss = useCallback((ms: number) => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = null;
      setRun(null);
      setError(null);
    }, ms);
  }, []);

  const startPolling = useCallback((runId: string, seed: GeneratorRunStatus) => {
    if (streamRef.current !== null) return; // SSE wins
    if (pollRef.current) return; // already polling
    setRun(statusToRunState(seed));
    if (seed.error) setError(seed.error);
    const tick = async (): Promise<void> => {
      try {
        const status = await getGeneratorRunStatus(runId);
        if (status === null) {
          // 404 — run has been grace-evicted server-side. Drop the local
          // anchor so subsequent mounts don't loop on a stale id.
          stopPolling();
          clearStored();
          return;
        }
        if (isTerminalStatus(status.status)) {
          const terminalState = statusToRunState(status);
          setRun((prev) => {
            // Preserve "cancelling" if the user has clicked Cancel and the
            // server has not yet flipped to "cancelled"; otherwise reflect
            // the terminal state so the summary line renders.
            if (prev?.status === "cancelling" && status.status !== "cancelled") return prev;
            return terminalState;
          });
          if (status.error) setError(status.error);
          stopPolling();
          clearStored();
          // Wave 5.45 — auto-dismiss the terminal summary.
          scheduleDismiss(
            status.status === "error" || status.error ? AUTO_DISMISS_ERROR_MS : AUTO_DISMISS_DONE_MS,
          );
          // Wave 5.56 — new rows may have landed; invalidate cached /facets.
          dispatchFacetsStale();
        } else {
          setRun((prev) => {
            const next = statusToRunState(status);
            if (prev?.status === "cancelling") return { ...next, status: "cancelling" };
            return next;
          });
        }
      } catch {
        // Swallow transient network errors; the next tick retries.
      }
    };
    const interval = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
    pollRef.current = { runId, interval };
  }, [stopPolling, scheduleDismiss]);

  const clearRun = useCallback(() => {
    setRun(null);
    setError(null);
  }, []);

  const startRun = useCallback((cfg: GeneratorConfig | null) => {
    setError(null);
    // Wave 5.40b — a manual start always wins over any in-progress polling
    // or pending post-terminal grace timer left over from a refresh.
    if (pollRef.current) {
      clearInterval(pollRef.current.interval);
      pollRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    // Wave 5.45 — a manual start also clears any pending auto-dismiss timer
    // from a previous terminal run so the new run renders immediately.
    clearDismissTimer();
    writtenRunIdRef.current = null;
    const initialRows = cfg?.rows ?? DEFAULT_GEN_ROWS;
    setRun({
      rowsTotal: initialRows,
      rowsDone: 0,
      elapsedMs: 0,
      rowsPerSec: 0,
      runId: null,
      status: "running",
    });
    const handle = startGeneratorStream(cfg ?? undefined, {
      onProgress: (f: ProgressFrame) => {
        setRun((prev) => {
          if (!prev || prev.status === "done" || prev.status === "cancelled" || prev.status === "error") return prev;
          return {
            rowsTotal: f.rows_total,
            rowsDone: f.rows_done,
            elapsedMs: f.elapsed_ms,
            rowsPerSec: f.rows_per_sec,
            runId: f.run_id,
            status: prev.status, // preserve "cancelling" if user already clicked cancel
          };
        });
        // Wave 5.40b — capture run_id in localStorage so a refresh can
        // reconnect via polling. Idempotent per-run via writtenRunIdRef.
        if (writtenRunIdRef.current !== f.run_id) {
          writtenRunIdRef.current = f.run_id;
          writeStored({ run_id: f.run_id, rows_total: f.rows_total, started_at: Date.now() });
        }
      },
      onTerminal: (f: TerminalFrame) => {
        setRun({
          rowsTotal: f.rows_queued,
          rowsDone: f.rows_queued,
          elapsedMs: f.ms,
          rowsPerSec: 0,
          runId: f.run_id,
          status: f.cancelled ? "cancelled" : "done",
          terminalMs: f.ms,
          // Wave 5.47c — fall back to legacy flags for older api builds that
          // do not yet emit stop_reason on the terminal frame.
          stopReason: f.stop_reason
            ?? (f.error ? "error" : f.cancelled ? "cancelled" : "rows"),
        });
        if (f.error) setError(f.error);
        streamRef.current = null;
        // Wave 5.40b — the run is over; clear the recovery anchor so the
        // next mount doesn't try to reconnect to a finished run.
        clearStored();
        writtenRunIdRef.current = null;
        // Wave 5.45 — auto-dismiss the pill once the terminal summary has
        // been on screen for the configured window.
        scheduleDismiss(f.error ? AUTO_DISMISS_ERROR_MS : AUTO_DISMISS_DONE_MS);
        // Wave 5.56 — terminal SSE frame ⇒ /facets may be stale.
        dispatchFacetsStale();
      },
      onError: (e: Error) => {
        setError(e.message);
        setRun((prev) => (prev ? { ...prev, status: "error" } : prev));
        streamRef.current = null;
        // Wave 5.45 — auto-dismiss the error summary.
        scheduleDismiss(AUTO_DISMISS_ERROR_MS);
        // Wave 5.56 — partial rows may still have been written before the
        // stream failed; invalidate /facets just in case.
        dispatchFacetsStale();
      },
    });
    streamRef.current = handle;
  }, [clearDismissTimer, scheduleDismiss]);

  const cancelRun = useCallback(() => {
    setRun((prev) => (prev && prev.status === "running" ? { ...prev, status: "cancelling" } : prev));
    if (streamRef.current) {
      void streamRef.current.cancel();
    } else if (pollRef.current) {
      // Wave 5.40b — polling-mode cancel: the SSE handle is gone (we
      // reconnected after a refresh), so hit the cancel endpoint directly.
      // The next poll will pick up status === "cancelled" and clear state.
      void cancelGenerator(pollRef.current.runId).catch(() => { /* swallow */ });
    }
  }, []);

  // Wave 5.40b — mount-time reconnect. Reads localStorage first, then runs
  // orphan-discovery against GET /generator/runs to adopt any run the UI is
  // not yet tracking (e.g. localStorage cleared but server still has it).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let adoptedRunId: string | null = null;
      const stored = readStored();
      if (stored?.run_id) {
        let status: GeneratorRunStatus | null = null;
        try { status = await getGeneratorRunStatus(stored.run_id); } catch { status = null; }
        if (cancelled) return;
        if (status === null) {
          // 404 — stale entry from a previous session that has been
          // grace-evicted server-side.
          clearStored();
        } else if (status.status === "running") {
          if (streamRef.current === null) {
            startPolling(stored.run_id, status);
            adoptedRunId = stored.run_id;
          }
        } else {
          // Terminal — show the summary line once, then drop the storage
          // entry after the grace window so later refreshes are clean.
          setRun(statusToRunState(status));
          if (status.error) setError(status.error);
          adoptedRunId = stored.run_id;
          graceTimerRef.current = setTimeout(() => {
            clearStored();
            graceTimerRef.current = null;
          }, TERMINAL_GRACE_MS);
        }
      }

      // Orphan discovery — always run even when localStorage was empty so
      // we recover from a wiped/disabled storage. If multiple runs are
      // active the registry's insertion order makes the last entry the
      // most-recently-started one.
      let list: { active: { run_id: string; status: string; rows_done: number; rows_total: number }[] } | null = null;
      try { list = await getActiveGeneratorRuns(); } catch { list = null; }
      if (cancelled) return;
      if (list && Array.isArray(list.active) && list.active.length > 0) {
        const orphan = list.active[list.active.length - 1]!;
        if (
          orphan.status === "running"
          && orphan.run_id !== adoptedRunId
          && streamRef.current === null
          && pollRef.current === null
        ) {
          writeStored({
            run_id: orphan.run_id,
            rows_total: orphan.rows_total,
            started_at: Date.now(),
          });
          startPolling(orphan.run_id, {
            run_id: orphan.run_id,
            status: "running",
            rows_done: orphan.rows_done,
            rows_total: orphan.rows_total,
            rows_per_sec: 0,
            elapsed_ms: 0,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        void streamRef.current.cancel();
        streamRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current.interval);
        pollRef.current = null;
      }
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      // Wave 5.45 — clear any pending auto-dismiss so we don't setState on
      // an unmounted provider.
      if (dismissTimerRef.current !== null) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, []);

  return (
    <GeneratorRunContext.Provider value={{ run, error, startRun, cancelRun, clearRun }}>
      {children}
    </GeneratorRunContext.Provider>
  );
}

export function useGeneratorRun(): GeneratorRunContextValue {
  const ctx = useContext(GeneratorRunContext);
  if (!ctx) {
    throw new Error("useGeneratorRun must be used within a <GeneratorRunProvider>");
  }
  return ctx;
}
