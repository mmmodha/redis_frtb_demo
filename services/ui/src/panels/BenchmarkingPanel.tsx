import { PanelCard } from "../components/PanelCard";
import { useBenchmarkRun } from "../context/BenchmarkRunContext";
import {
  formatBenchmarkRows,
  formatBenchmarkWallMs,
  type BenchmarkStep,
} from "../lib/benchmark";

function BenchmarkStepStatus({ step }: { step: BenchmarkStep }) {
  if (step.status === "running") {
    return (
      <span className="benchmark-status benchmark-status--running">
        <span className="spinner benchmark-status__spinner" aria-hidden="true" />
        Running…
      </span>
    );
  }
  if (step.status === "done") {
    return (
      <span className="benchmark-status benchmark-status--done">
        <span className="benchmark-status__tick" aria-hidden="true">✓</span>
        Done
      </span>
    );
  }
  if (step.status === "error") {
    return (
      <span className="benchmark-status benchmark-status--error">
        {step.error ?? "Error"}
      </span>
    );
  }
  if (step.status === "skipped" || !step.runnable) {
    return (
      <span className="benchmark-status benchmark-status--skipped">
        Needs ingest at this scale
      </span>
    );
  }
  return (
    <span className="benchmark-status benchmark-status--pending">
      Pending
    </span>
  );
}

export function BenchmarkingPanel() {
  const {
    phase,
    portfolio,
    steps,
    rollup,
    runError,
    runningIndex,
    runnableCount,
    isRunning,
    refreshPortfolio,
    startBenchmark,
  } = useBenchmarkRun();

  const canRun = (phase === "ready" || phase === "done" || phase === "error") && runnableCount > 0;
  const rollupWarn = rollup !== null && rollup.total > 0 && rollup.missing > 0;

  return (
    <PanelCard title="Total SBM benchmark">
      <p className="admin-stub">
        One cold <code>POST /calc/sbm/total?nocache=1</code> for the current ingested portfolio
        (labelled at the nearest ladder step). Lower ladder rows are for separate ingests at those
        scales. The Calculation tab is unchanged and still uses cache on repeat runs.
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
          Cold runs this click:{" "}
          <strong data-testid="benchmark-step-count">{runnableCount}</strong>
          {steps.length > runnableCount && (
            <span className="benchmark-summary__meta">
              {" "}
              ({steps.length - runnableCount} ladder row
              {steps.length - runnableCount === 1 ? "" : "s"} skipped — need ingest at that scale)
            </span>
          )}
        </div>
        {rollup !== null && rollup.total > 0 && (
          <div data-testid="benchmark-rollup-status">
            Rollups: {rollup.present}/{rollup.total} present
          </div>
        )}
        {rollupWarn && (
          <div className="benchmark-warning" data-testid="benchmark-rollup-warn" role="alert">
            {rollup.missing} rollup tuple(s) missing — calc may fall back to a slow FT.AGGREGATE
            scan. Run <code>finalise-rollups.mjs</code> after ingest before benchmarking.
          </div>
        )}
        {isRunning && (
          <div className="benchmark-summary__active" data-testid="benchmark-running-banner">
            Benchmark in progress — you can switch tabs; progress continues in the background.
          </div>
        )}
      </div>

      <div className="admin-form__actions benchmark-actions">
        <button
          type="button"
          className="benchmark-btn benchmark-btn--primary"
          onClick={() => startBenchmark()}
          disabled={!canRun || isRunning}
          data-testid="benchmark-run"
        >
          {isRunning
            ? `Running cold Total SBM (${runningIndex + 1}/${runnableCount})…`
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
          No benchmark steps — run a bulk ingest, then refresh.
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
                  data-runnable={step.runnable ? "true" : "false"}
                >
                  <td>{formatBenchmarkRows(step.tier_rows)}</td>
                  <td data-testid={`benchmark-wall-${step.tier_rows}`}>
                    {formatBenchmarkWallMs(step.wall_ms)}
                  </td>
                  <td>
                    <BenchmarkStepStatus step={step} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {steps.length > 0 && (
        <p className="admin-stub benchmark-note">
          Click <strong>Run benchmark</strong> — when the runnable row shows Done, the{" "}
          <strong>Wall time</strong> column holds <code>performance.total_ms</code> from the cold
          Total SBM response. Lower ladder rows need a separate ingest at that scale (or a future
          bucket-subset mode) before they can record their own timings.
        </p>
      )}
    </PanelCard>
  );
}
