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
    runError,
    runningIndex,
    isRunning,
    refreshPortfolio,
    startBenchmark,
  } = useBenchmarkRun();

  const canRun = (phase === "ready" || phase === "done" || phase === "error") && steps.length > 0;

  return (
    <PanelCard title="Total SBM benchmark">
      <p className="admin-stub">
        Cold <code>POST /calc/sbm/total?nocache=1</code> at each portfolio scale step up to the
        detected row count. This panel only — the Calculation tab is unchanged and still uses the
        normal cache on repeat runs.
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
        {isRunning && (
          <div className="benchmark-summary__active" data-testid="benchmark-running-banner">
            Benchmark in progress — you can switch tabs; progress continues in the background.
            {" "}
            Step {runningIndex + 1} of {steps.length}.
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
          Each step runs a full cold Total SBM over the entire ingested portfolio (~30–40s per
          step at 400M with rollups). Five steps typically take several minutes — this is expected
          and does not affect normal Calculation performance.
        </p>
      )}
    </PanelCard>
  );
}
