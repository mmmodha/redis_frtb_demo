import { useCallback, useEffect, useState } from "react";
import { PanelCard } from "../components/PanelCard";
import {
  benchmarkTiersUpTo,
  estimatePortfolioRows,
  formatBenchmarkRows,
  formatBenchmarkWallMs,
  initialBenchmarkSteps,
  runTotalSbmBenchmarkCold,
  type BenchmarkStep,
  type PortfolioRowEstimate,
} from "../lib/benchmark";

type PanelPhase = "idle" | "loading-rows" | "ready" | "running" | "done" | "error";

export function BenchmarkingPanel() {
  const [phase, setPhase] = useState<PanelPhase>("loading-rows");
  const [portfolio, setPortfolio] = useState<PortfolioRowEstimate>({ rows: 0, source: "unknown" });
  const [steps, setSteps] = useState<BenchmarkStep[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [runningIndex, setRunningIndex] = useState(-1);

  const refreshPortfolio = useCallback(async () => {
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

  const onRun = useCallback(async () => {
    if (steps.length === 0) return;
    setRunError(null);
    setPhase("running");
    setSteps((prev) => prev.map((s) => ({
      ...s,
      wall_ms: null,
      total_sbm: null,
      status: "pending",
      error: undefined,
    })));

    for (let i = 0; i < steps.length; i++) {
      const tier = steps[i]!.tier_rows;
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
  }, [steps]);

  const isRunning = phase === "running";
  const canRun = (phase === "ready" || phase === "done" || phase === "error") && steps.length > 0;

  return (
    <PanelCard title="Total SBM benchmark">
      <p className="admin-stub">
        Cold <code>POST /calc/sbm/total?nocache=1</code> at each portfolio scale step up to the
        detected row count. Each step measures wall-clock time for a full Total SBM calculation.
      </p>

      <div className="benchmark-summary" data-testid="benchmark-summary">
        <div>
          Portfolio:{" "}
          <strong data-testid="benchmark-portfolio-rows">
            {portfolio.rows > 0 ? `~${formatBenchmarkRows(portfolio.rows)} rows` : "unknown"}
          </strong>
          {portfolio.rows > 0 && (
            <span className="benchmark-summary__meta"> ({portfolio.source})</span>
          )}
        </div>
        <div>
          Ladder steps:{" "}
          <strong data-testid="benchmark-step-count">{steps.length}</strong>
          {steps.length > 0 && (
            <span className="benchmark-summary__meta">
              {" "}
              ({steps.map((s) => formatBenchmarkRows(s.tier_rows)).join(", ")})
            </span>
          )}
        </div>
      </div>

      <div className="admin-form__actions benchmark-actions">
        <button
          type="button"
          className="benchmark-btn benchmark-btn--primary"
          onClick={() => void onRun()}
          disabled={!canRun || isRunning}
          data-testid="benchmark-run"
        >
          {isRunning
            ? `Running ${runningIndex + 1}/${steps.length}…`
            : "Run benchmark"}
        </button>
        <button
          type="button"
          className="benchmark-btn benchmark-btn--secondary"
          onClick={() => void refreshPortfolio()}
          disabled={isRunning}
          data-testid="benchmark-refresh"
        >
          Refresh row count
        </button>
      </div>

      {phase === "loading-rows" && (
        <div className="admin-skeleton" role="status" data-testid="benchmark-loading">
          Detecting portfolio size…
        </div>
      )}

      {runError && (
        <div className="admin-error" role="alert" data-testid="benchmark-error">
          {runError}
        </div>
      )}

      {steps.length === 0 && phase === "ready" && (
        <p className="admin-stub" data-testid="benchmark-no-tiers">
          No benchmark steps — ingest data or set an active target, then refresh.
        </p>
      )}

      {steps.length > 0 && (
        <div className="benchmark-table-wrap">
          <table className="benchmark-table" data-testid="benchmark-table">
            <thead>
              <tr>
                <th scope="col">Rows</th>
                <th scope="col">Wall time</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => (
                <tr
                  key={step.tier_rows}
                  data-testid={`benchmark-row-${step.tier_rows}`}
                  data-status={step.status}
                >
                  <td>{formatBenchmarkRows(step.tier_rows)}</td>
                  <td data-testid={`benchmark-wall-${step.tier_rows}`}>
                    {formatBenchmarkWallMs(step.wall_ms)}
                  </td>
                  <td>
                    {step.status === "pending" && "Pending"}
                    {step.status === "running" && "Running…"}
                    {step.status === "done" && "Done"}
                    {step.status === "error" && (step.error ?? "Error")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {steps.length > 0 && (
        <p className="admin-stub benchmark-note">
          Each run executes Total SBM over the full ingested portfolio. With rollups present,
          wall times are typically similar across scale labels on a single loaded cluster.
        </p>
      )}
    </PanelCard>
  );
}
