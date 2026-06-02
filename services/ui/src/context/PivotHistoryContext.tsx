// Wave 5.22 — global pivot history. Lifts the run latency/result state out of
// PivotPanel so navigating to another route (e.g. /calc) and back leaves the
// strip chart populated. Sits as a sibling to PivotBurstProvider above
// <Routes> in App.tsx. History is intentionally in-memory only — refresh
// wipes it.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { PivotResp } from "../lib/pivot";

const HIST_WINDOW = 100;

export interface PivotHistoryContextValue {
  result: PivotResp | null;
  serverMs: number[];
  clientMs: number[];
  offset: number;
  push: (server: number, client: number, result: PivotResp) => void;
  setOffset: (n: number) => void;
  reset: () => void;
}

export const PivotHistoryContext = createContext<PivotHistoryContextValue | null>(null);

export function PivotHistoryProvider({ children }: { children: ReactNode }): JSX.Element {
  const [result, setResult] = useState<PivotResp | null>(null);
  const [serverMs, setServerMs] = useState<number[]>([]);
  const [clientMs, setClientMs] = useState<number[]>([]);
  const [offset, setOffset] = useState<number>(0);

  const push = useCallback((server: number, client: number, body: PivotResp) => {
    setResult(body);
    setServerMs((prev) => [...prev.slice(-(HIST_WINDOW - 1)), server]);
    setClientMs((prev) => [...prev.slice(-(HIST_WINDOW - 1)), client]);
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setServerMs([]);
    setClientMs([]);
    setOffset(0);
  }, []);

  return (
    <PivotHistoryContext.Provider
      value={{ result, serverMs, clientMs, offset, push, setOffset, reset }}
    >
      {children}
    </PivotHistoryContext.Provider>
  );
}

export function usePivotHistory(): PivotHistoryContextValue {
  const ctx = useContext(PivotHistoryContext);
  if (!ctx) {
    throw new Error("usePivotHistory must be used within a <PivotHistoryProvider>");
  }
  return ctx;
}
