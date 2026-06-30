import { PanelCard } from "../PanelCard";
import type { IngestRunHistoryEntry } from "../../lib/ingestRunHistory";
import {
  formatDurationMs,
  formatEndpoint,
  formatStartedAtTime,
  groupIngestRunsByDate,
  statusClass,
  statusLabel,
} from "../../lib/ingestRunHistoryDisplay";

function fmtRows(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

function fmtRps(n: number): string {
  return Number.isFinite(n) && n > 0 ? n.toLocaleString("en-US") : "0";
}

function RunHistoryRow(props: {
  run: IngestRunHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { run, expanded, onToggle } = props;
  const pct = run.rows_total > 0
    ? Math.round((run.rows_written / run.rows_total) * 100)
    : 0;

  return (
    <li className="ingest-history__row" data-testid={`ingest-history-row-${run.run_id}`}>
      <button
        type="button"
        className="ingest-history__summary-btn"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid={`ingest-history-toggle-${run.run_id}`}
      >
        <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
        <span className="ingest-history__when">{formatStartedAtTime(run.started_at_iso)}</span>
        <span className="ingest-history__rows">
          {fmtRows(run.rows_written)} / {fmtRows(run.rows_total)} rows
        </span>
        <span className="ingest-history__rate">{fmtRps(run.avg_write_rps)} rows/s avg</span>
        <span className="ingest-history__endpoint" title={run.bulk_loader_base}>
          → {formatEndpoint(run.bulk_loader_base)}
        </span>
      </button>

      {expanded ? (
        <div className="ingest-history__detail" data-testid={`ingest-history-detail-${run.run_id}`}>
          <dl className="ingest-history__dl">
            <div>
              <dt>Run ID</dt>
              <dd data-testid="ingest-history-run-id">{run.run_id}</dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd data-testid="ingest-history-endpoint">{run.bulk_loader_base}</dd>
            </div>
            <div>
              <dt>Rows written</dt>
              <dd>{fmtRows(run.rows_written)} ({pct}%)</dd>
            </div>
            <div>
              <dt>Rows produced</dt>
              <dd>{fmtRows(run.rows_sent)}</dd>
            </div>
            <div>
              <dt>Avg write rate</dt>
              <dd data-testid="ingest-history-avg-write">{fmtRps(run.avg_write_rps)} rows/s</dd>
            </div>
            <div>
              <dt>Avg produce rate</dt>
              <dd>{fmtRps(run.avg_producer_rps)} rows/s</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDurationMs(run.duration_ms)}</dd>
            </div>
            <div>
              <dt>Workers</dt>
              <dd>{run.workers} · batch {run.batch_size} · concurrency {run.concurrency}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{run.started_at_iso}</dd>
            </div>
            <div>
              <dt>Ended</dt>
              <dd>{run.ended_at_iso}</dd>
            </div>
            {run.error ? (
              <div className="ingest-history__error-row">
                <dt>Error</dt>
                <dd>{run.error}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </li>
  );
}

function runCountLabel(n: number): string {
  return n === 1 ? "1 run" : `${n} runs`;
}

export function IngestRunHistoryCard(props: {
  runs: IngestRunHistoryEntry[];
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
}): JSX.Element {
  const { runs, expandedId, onExpandedChange } = props;
  const groups = groupIngestRunsByDate(runs);

  return (
    <PanelCard title="Recent runs">
      {runs.length === 0 ? (
        <p className="ingest-history__empty" data-testid="ingest-history-empty">
          Completed runs appear here with transfer rate and endpoint details.
        </p>
      ) : (
        <div className="ingest-history-groups" data-testid="ingest-history-groups">
          {groups.map((group, index) => (
            <details
              key={group.dateKey}
              className="ingest-history-group"
              open={index === 0}
              data-testid={`ingest-history-group-${group.dateKey}`}
            >
              <summary className="ingest-history-group__summary">
                <span className="ingest-history-group__label">{group.label}</span>
                <span className="ingest-history-group__count">{runCountLabel(group.runs.length)}</span>
              </summary>
              <ul className="ingest-history" data-testid="ingest-history-list">
                {group.runs.map((run) => (
                  <RunHistoryRow
                    key={run.run_id}
                    run={run}
                    expanded={expandedId === run.run_id}
                    onToggle={() => onExpandedChange(expandedId === run.run_id ? null : run.run_id)}
                  />
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </PanelCard>
  );
}
