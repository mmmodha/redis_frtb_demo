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
  buildBenchmarkPlan,
  estimatePortfolioRows,
  fetchBucketFacetsForBenchmark,
  fetchRollupPreflight,
  formatBenchmarkRows,
  resolveBenchmarkPortfolioRows,
  runTotalSbmBenchmarkCold,
  runnableBenchmarkSteps,
  type BenchmarkStep,
  type PortfolioRowEstimate,
  type RollupPreflight,
} from "../lib/benchmark";

export type BenchmarkPhase = "idle" | "loading-rows" | "ready" | "running" | "done" | "error";

export interface BenchmarkRunContextValue {
  phase: BenchmarkPhase;
  portfolio: PortfolioRowEstimate;
  steps: BenchmarkStep[];
  rollup: RollupPreflight | null;
  runError: string | null;
  runningIndex: number;
  runnableCount: number;
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
  const [rollup, setRollup] = useState<RollupPreflight | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runningIndex, setRunningIndex] = useState(-1);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const refreshPortfolio = useCallback(async () => {
    if (benchmarkInFlight) return;
    setPhase("loading-rows");
    setRunError(null);
    setRollup(null);
    try {
      const [est, bucketFacets] = await Promise.all([
        estimatePortfolioRows(),
        fetchBucketFacetsForBenchmark(),
      ]);
      const portfolio = resolveBenchmarkPortfolioRows(est, bucketFacets);
      setPortfolio(portfolio);
      setSteps(buildBenchmarkPlan(portfolio.rows, bucketFacets));
      setPhase("ready");
      // Rollup preflight can take minutes on large clusters (/admin/calc-coverage
      // 502s behind nginx) — never block the panel on it.
      void fetchRollupPreflight().then(setRollup).catch(() => setRollup(null));
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
    const plan = stepsRef.current;
    const toRun = runnableBenchmarkSteps(plan);
    if (toRun.length === 0) return;

    benchmarkInFlight = true;
    setRunError(null);
    setPhase("running");
    setRunningIndex(-1);
    setSteps(plan.map((s) => ({
      ...s,
      wall_ms: null,
      total_sbm: null,
      status: s.runnable ? "pending" : "skipped",
      error: undefined,
    })));

    void (async () => {
      try {
        let runIdx = 0;
        for (let i = 0; i < plan.length; i++) {
          const step = plan[i]!;
          if (!step.runnable) continue;

          const tier = step.tier_rows;
          setRunningIndex(runIdx);
          runIdx += 1;
          setSteps((prev) => prev.map((s, idx) => (
            idx === i ? { ...s, status: "running" } : s
          )));
          try {
            const t0 = performance.now();
            const res = await runTotalSbmBenchmarkCold(step.bucket_cells);
            const apiMs = res.performance?.total_ms;
            const wallMs = typeof apiMs === "number" && Number.isFinite(apiMs)
              ? apiMs
              : Math.round(performance.now() - t0);
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

  const runnableCount = runnableBenchmarkSteps(steps).length;

  const value: BenchmarkRunContextValue = {
    phase,
    portfolio,
    steps,
    rollup,
    runError,
    runningIndex,
    runnableCount,
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
