import { Link } from "react-router-dom";
import { PanelCard } from "../PanelCard";
import { useIngestRunHistory } from "../../hooks/useIngestRunHistory";
import {
  formatStartedAtTime,
  statusClass,
  statusLabel,
} from "../../lib/ingestRunHistoryDisplay";

const MAX_ROWS = 5;

export function IngestRunsCompactCard(): JSX.Element {
  const { runs, expandedId, setExpandedId } = useIngestRunHistory(0);
  const shown = runs.slice(0, MAX_ROWS);

  return (
    <PanelCard
      title="Recent ingest runs"
      actions={<Link to="/ingest" className="btn btn--secondary">View all</Link>}
    >
      {shown.length === 0 ? (
        <p className="obs-ingest-runs__empty" data-testid="obs-ingest-runs-empty">
          No completed ingest runs yet.
        </p>
      ) : (
        <ul className="obs-ingest-runs" data-testid="obs-ingest-runs-list">
          {shown.map((run) => (
            <li key={run.run_id} className="obs-ingest-runs__row">
              <button
                type="button"
                className="obs-ingest-runs__btn"
                onClick={() => setExpandedId(expandedId === run.run_id ? null : run.run_id)}
                aria-expanded={expandedId === run.run_id}
              >
                <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
                <span>{formatStartedAtTime(run.started_at_iso)}</span>
                <span>{run.rows_written.toLocaleString("en-US")} / {run.rows_total.toLocaleString("en-US")} rows</span>
              </button>
              {expandedId === run.run_id ? (
                <div className="obs-ingest-runs__detail" data-testid={`obs-ingest-run-detail-${run.run_id}`}>
                  <div><strong>Run</strong> <code>{run.run_id}</code></div>
                  <div><strong>Endpoint</strong> {run.bulk_loader_base}</div>
                  {run.error ? <div className="obs-ingest-runs__err">{run.error}</div> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  );
}
