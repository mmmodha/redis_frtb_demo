// Wave 5.21g — global pivot burst state.
//
// The "Run 100x" loop used to live inside PivotPanel; unmounting the panel
// (e.g. navigating to /calc) abandoned the in-flight loop. Lifting the loop +
// AbortController into a provider that sits above <Routes> keeps the burst
// running across route changes, and lets AppShell render a nav pill from any
// route. Filter values are captured at startBurst time so mid-burst filter
// edits don't affect in-flight iterations.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PivotResp } from "../lib/pivot";
import { runPivot, type PivotRunFilters } from "../lib/pivot-run";
import { EmptyTargetError } from "../lib/empty-target";

export interface PivotBurstState {
  done: number;
  total: number;
}

export interface PivotBurstStartArgs {
  total: number;
  filters: PivotRunFilters;
  onIteration?: (body: PivotResp, clientMs: number) => void;
  onError?: (err: Error | EmptyTargetError) => void;
}

export interface PivotBurstContextValue {
  burst: PivotBurstState | null;
  startBurst: (args: PivotBurstStartArgs) => void;
  cancelBurst: () => void;
}

export const PivotBurstContext = createContext<PivotBurstContextValue | null>(null);

export function PivotBurstProvider({ children }: { children: ReactNode }): JSX.Element {
  const [burst, setBurst] = useState<PivotBurstState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef<boolean>(false);

  const cancelBurst = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    runningRef.current = false;
    setBurst(null);
  }, []);

  const startBurst = useCallback((args: PivotBurstStartArgs) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setBurst({ done: 0, total: args.total });
    void (async () => {
      for (let i = 0; i < args.total; i++) {
        if (controller.signal.aborted) {
          runningRef.current = false;
          setBurst(null);
          return;
        }
        try {
          const { body, clientMs } = await runPivot(args.filters, controller.signal);
          if (controller.signal.aborted) {
            runningRef.current = false;
            setBurst(null);
            return;
          }
          args.onIteration?.(body, clientMs);
          setBurst({ done: i + 1, total: args.total });
        } catch (e) {
          if (controller.signal.aborted) {
            runningRef.current = false;
            setBurst(null);
            return;
          }
          const err = e instanceof Error ? e : new Error("Failed to load pivot");
          args.onError?.(err);
          runningRef.current = false;
          abortRef.current = null;
          setBurst(null);
          return;
        }
      }
      runningRef.current = false;
      abortRef.current = null;
      setBurst(null);
    })();
  }, []);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return (
    <PivotBurstContext.Provider value={{ burst, startBurst, cancelBurst }}>
      {children}
    </PivotBurstContext.Provider>
  );
}

export function usePivotBurst(): PivotBurstContextValue {
  const ctx = useContext(PivotBurstContext);
  if (!ctx) {
    throw new Error("usePivotBurst must be used within a <PivotBurstProvider>");
  }
  return ctx;
}
