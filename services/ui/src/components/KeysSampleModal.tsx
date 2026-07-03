export function KeysSampleModal(props: {
  open: boolean;
  onClose: () => void;
  dbsize: number;
  prefix: string;
  sample: string[];
}): JSX.Element | null {
  const { open, onClose, dbsize, prefix, sample } = props;
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Key sample">
      <div className="dialog keys-sample-modal" data-testid="keys-sample-modal">
        <h2>Key sample</h2>
        <p className="keys-sample-modal__meta">
          <span data-testid="keys-sample-dbsize">{dbsize.toLocaleString("en-US")}</span> total keys
          {" · "}
          prefix <code>{prefix}*</code>
          {" · "}
          showing {sample.length} of scan sample
        </p>
        {sample.length === 0 ? (
          <p className="keys-sample-modal__empty" data-testid="keys-sample-empty">No keys matched the scan sample.</p>
        ) : (
          <ul className="keys-sample-modal__list" data-testid="keys-sample-list">
            {sample.map((k) => (
              <li key={k}><code>{k}</code></li>
            ))}
          </ul>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
