import { useCallback, useEffect, useState } from "react";
import { PanelCard } from "./PanelCard";
import { getRecentErrors, type RecentErrorEntry } from "../lib/admin";

const POLL_MS = 5_000;
const GREP_CMD = (id: string) => `docker compose logs api | grep ${id}`;

function CopyGrepButton({ requestId }: { requestId: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(GREP_CMD(requestId));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, [requestId]);
  return (
    <button
      type="button"
      className="btn btn--secondary log-tail-copy-btn"
      onClick={() => { void onCopy(); }}
      data-testid={`grep-copy-${requestId}`}
      title={GREP_CMD(requestId)}
    >
      {copied ? "Copied" : "Copy grep"}
    </button>
  );
}

export function RecentErrorsCard(): JSX.Element {
  const [items, setItems] = useState<RecentErrorEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await getRecentErrors(15);
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) void poll(); };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [poll]);

  return (
    <PanelCard title="Recent API errors">
      <p className="admin-stub">
        Last server errors (5xx and unhandled exceptions). Use the request_id to grep
        container logs: <code>docker compose logs api | grep &lt;request_id&gt;</code>
      </p>
      {error ? <p className="admin-error" role="alert">{error}</p> : null}
      {items.length === 0 ? (
        <p className="admin-stub" data-testid="recent-errors-empty">No recent errors recorded.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table" data-testid="recent-errors-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Route</th>
                <th>Status</th>
                <th>Error</th>
                <th>Request ID</th>
                <th>Logs</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} data-testid={`recent-error-${e.id}`}>
                  <td>{e.ts.replace("T", " ").slice(0, 19)}</td>
                  <td><code>{e.method} {e.route}</code></td>
                  <td>{e.status_code}</td>
                  <td>{e.error}</td>
                  <td><code>{e.request_id}</code></td>
                  <td><CopyGrepButton requestId={e.request_id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  );
}
