export function IngestAdminFooter(props: {
  flushBusy: boolean;
  stopAllBusy: boolean;
  flushBanner: string | null;
  stopAllBanner: string | null;
  onFlushClick: () => void;
  onStopAllClick: () => void;
}): JSX.Element {
  const {
    flushBusy, stopAllBusy, flushBanner, stopAllBanner,
    onFlushClick, onStopAllClick,
  } = props;

  return (
    <details className="ingest-admin-footer" data-testid="ingest-admin-footer">
      <summary className="ingest-admin-footer__summary">Advanced</summary>
      <div className="ingest-admin-footer__body">
        <p className="ingest-admin-footer__hint">
          Destructive actions — stop producers or wipe the Redis database.
        </p>
        <div className="ingest-admin">
          <button
            type="button"
            className="btn btn--danger"
            onClick={onFlushClick}
            disabled={flushBusy}
            data-testid="flush-db-btn"
          >
            {flushBusy ? "Flushing…" : "Flush DB"}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={onStopAllClick}
            disabled={stopAllBusy}
            data-testid="stop-all-runs-btn"
          >
            {stopAllBusy ? "Stopping…" : "Stop all runs"}
          </button>
          {flushBanner ? (
            <span className="ingest-admin__banner" data-testid="flush-db-banner" role="status">
              {flushBanner}
            </span>
          ) : null}
          {stopAllBanner ? (
            <span className="ingest-admin__banner" data-testid="stop-all-runs-banner" role="status">
              {stopAllBanner}
            </span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
