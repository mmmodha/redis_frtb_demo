// Wave 5.38a — global synthetic generator run state.
//
// The streaming generator run used to live inside SyntheticGeneratorCard;
// unmounting IngestPanel (e.g. navigating to /calc) abandoned the in-flight
// SSE stream and dropped its progress UI. Lifting the run state +
// GeneratorStreamHandle into a provider that sits above <Routes> keeps the
// run alive across route changes, and lets AppShell render a nav pill from
// any route. Modelled on PivotBurstContext (Wave 5.21g).

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
  startGeneratorStream,
  type GeneratorConfig,
  type GeneratorStreamHandle,
  type ProgressFrame,
  type TerminalFrame,
} from "../lib/ingest";

// Default row count when the caller posts an empty body (cfg === null);
// matches services/api/src/routes/generator.ts DEFAULT_ROWS.
const DEFAULT_GEN_ROWS = 200;

export interface GeneratorRunState {
  rowsTotal: number;
  rowsDone: number;
  elapsedMs: number;
  rowsPerSec: number;
  runId: string | null;
  status: "running" | "cancelling" | "done" | "cancelled" | "error";
  terminalMs?: number;
}

export interface GeneratorRunContextValue {
  run: GeneratorRunState | null;
  error: string | null;
  startRun: (cfg: GeneratorConfig | null) => void;
  cancelRun: () => void;
  clearRun: () => void;
}

export const GeneratorRunContext = createContext<GeneratorRunContextValue | null>(null);

export function GeneratorRunProvider({ children }: { children: ReactNode }): JSX.Element {
  const [run, setRun] = useState<GeneratorRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<GeneratorStreamHandle | null>(null);

  const clearRun = useCallback(() => {
    setRun(null);
    setError(null);
  }, []);

  const startRun = useCallback((cfg: GeneratorConfig | null) => {
    setError(null);
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
        });
        if (f.error) setError(f.error);
        streamRef.current = null;
      },
      onError: (e: Error) => {
        setError(e.message);
        setRun((prev) => (prev ? { ...prev, status: "error" } : prev));
        streamRef.current = null;
      },
    });
    streamRef.current = handle;
  }, []);

  const cancelRun = useCallback(() => {
    setRun((prev) => (prev && prev.status === "running" ? { ...prev, status: "cancelling" } : prev));
    void streamRef.current?.cancel();
  }, []);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        void streamRef.current.cancel();
        streamRef.current = null;
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
