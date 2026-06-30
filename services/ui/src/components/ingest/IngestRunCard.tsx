import { PhaseProgress } from "../PhaseProgress";
import { shouldShowProgressCard, type RunUiPhase } from "../../lib/ingestRunState";

export function IngestRunCard(props: {
  phase: RunUiPhase;
  written: number;
  total: number;
  writeRps: number;
  summaryText: string | null;
  onCancel?: () => void;
}): JSX.Element | null {
  const { phase, written, total, writeRps, summaryText, onCancel } = props;
  if (!shouldShowProgressCard(phase)) return null;

  if (phase === "summary" && summaryText) {
    return (
      <div className="ingest-run-summary" data-testid="ingest-run-summary" role="status">
        {summaryText}
      </div>
    );
  }

  return (
    <div className="ingest-run-card" data-testid="ingest-run-card">
      <PhaseProgress
        label="Rows written"
        done={written}
        total={total}
        ratePerSec={writeRps}
        onCancel={onCancel}
        testIdPrefix="phase-progress-ingest"
      />
    </div>
  );
}
