// Benchmark run state lives above <Routes> so cold Total SBM ladder runs
// continue when the operator navigates away from /benchmarking. Uses the
// same module-level in-flight gate pattern as CalcRunContext.

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
  benchmarkTiersUpTo,
  estimatePortfolioRows,
  formatBenchmarkRows,
  initialBenchmarkSteps,
  runTotalSbmBenchmarkCold,
  type BenchmarkStep,
  type PortfolioRowEstimate,
} from "../lib/benchmark";

export type BenchmarkPhase = "idle" | "loading-rows" | "ready" | "running" | "done" | "error";

export interface BenchmarkRunContextValue {
  phase: BenchmarkPhase;
  portfolio: PortfolioRowEstimate;
  steps: BenchmarkStep[];
  runError: string | null;
  runningIndex: number;
  isRunning: boolean;
  refreshPortfolio: () => Promise<void>;
  startBenchmark: () => void;
}

export const BenchmarkRunContext = createContext<BenchmarkRunContextValue | null>(null);

let benchmarkInFlight = false;

/** Test-only reset for module-level in-flight gate. */
export function resetBenchmarkRunForTests(): void {
  benchmarkInFlight = false;
}

export function BenchmarkRunProvider({ children }: { children: ReactNode }): JSX.Element {
  const [phase, setPhase] = useState<BenchmarkPhase>("loading-rows");
  const [portfolio, setPortfolio] = useState<PortfolioRowEstimate>({ rows: 0, source: "unknown" });
  const [steps, setSteps] = useState<BenchmarkStep[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [runningIndex, setRunningIndex] = useState(-1);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const refreshPortfolio = useCallback(async () => {
    if (benchmarkInFlight) return;
    setPhase("loading-rows");
    setRunError(null);
    try {
      const est = await estimatePortfolioRows();
      setPortfolio(est);
      const tiers = benchmarkTiersUpTo(est.rows);
      setSteps(initialBenchmarkSteps(tiers));
      setPhase("ready");
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void refreshPortfolio();
  }, [refreshPortfolio]);

  const startBenchmark = useCallback(() => {
    if (benchmarkInFlight) return;
    const tierSteps = stepsRef.current;
    if (tierSteps.length === 0) return;

    benchmarkInFlight = true;
    setRunError(null);
    setPhase("running");
    setRunningIndex(-1);
    setSteps(tierSteps.map((s) => ({
      ...s,
      wall_ms: null,
      total_sbm: null,
      status: "pending",
      error: undefined,
    })));

    void (async () => {
      try {
        for (let i = 0; i < tierSteps.length; i++) {
          const tier = tierSteps[i]!.tier_rows;
          setRunningIndex(i);
          setSteps((prev) => prev.map((s, idx) => (
            idx === i ? { ...s, status: "running" } : s
          )));
          try {
            const res = await runTotalSbmBenchmarkCold();
            const wallMs = res.performance?.total_ms ?? null;
            setSteps((prev) => prev.map((s, idx) => (
              idx === i
                ? {
                  ...s,
                  status: "done",
                  wall_ms: wallMs,
                  total_sbm: res.total_sbm ?? null,
                }
                : s
            )));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setSteps((prev) => prev.map((s, idx) => (
              idx === i ? { ...s, status: "error", error: message } : s
            )));
            setRunError(`Failed at ${formatBenchmarkRows(tier)} scale: ${message}`);
            setPhase("error");
            setRunningIndex(-1);
            return;
          }
        }
        setRunningIndex(-1);
        setPhase("done");
      } finally {
        benchmarkInFlight = false;
      }
    })();
  }, []);

  const value: BenchmarkRunContextValue = {
    phase,
    portfolio,
    steps,
    runError,
    runningIndex,
    isRunning: phase === "running",
    refreshPortfolio,
    startBenchmark,
  };

  return (
    <BenchmarkRunContext.Provider value={value}>
      {children}
    </BenchmarkRunContext.Provider>
  );
}

export function useBenchmarkRun(): BenchmarkRunContextValue {
  const ctx = useContext(BenchmarkRunContext);
  if (!ctx) throw new Error("useBenchmarkRun requires BenchmarkRunProvider");
  return ctx;
}
