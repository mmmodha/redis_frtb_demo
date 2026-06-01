// Wave 5.16z1 — full-width banner that sits at the top of <main> in AppShell
// reflecting the current bootstrap phase reported by the api. Amber while a
// fresh target is bootstrapping FRTB (Lua snippets + idx:sens), red on
// failure with a Retry button that re-activates the same profile so the api
// re-runs the bootstrap path. Renders nothing for the idle/ready phases so
// steady-state navigation is uncluttered.

import { useState } from "react";
import { useBootstrapStatus } from "../hooks/useBootstrapStatus";
import { activateConnection, listConnections } from "../lib/connections";

export function BootstrapStatusOverlay() {
  const { snapshot, refresh } = useBootstrapStatus();
  const [retrying, setRetrying] = useState<boolean>(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const phase = snapshot?.phase ?? "idle";
  if (phase === "idle" || phase === "ready") return null;

  const targetLabel = snapshot?.target_label ?? "active target";

  const onRetry = async (): Promise<void> => {
    setRetrying(true);
    setRetryError(null);
    try {
      const profiles = await listConnections();
      const match = profiles.find((p) => (p.label ?? p.name) === targetLabel);
      if (!match) throw new Error(`no connection profile matches ${targetLabel}`);
      await activateConnection(match.id);
      // Notify the shell + restart polling so we pick up the new phase.
      window.dispatchEvent(new CustomEvent("connections:active-changed"));
      refresh();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  if (phase === "running") {
    return (
      <div
        className="bootstrap-overlay bootstrap-overlay--running"
        role="status"
        aria-live="polite"
        data-slot="bootstrap-overlay"
        data-phase="running"
        data-testid="bootstrap-overlay"
      >
        <span className="spinner" aria-hidden="true" />
        <span className="bootstrap-overlay__text">
          Bootstrapping FRTB on <strong>{targetLabel}</strong>…
        </span>
      </div>
    );
  }

  // phase === "failed"
  const errText = snapshot?.err ?? "bootstrap failed";
  return (
    <div
      className="bootstrap-overlay bootstrap-overlay--failed"
      role="alert"
      data-slot="bootstrap-overlay"
      data-phase="failed"
      data-testid="bootstrap-overlay"
    >
      <div className="bootstrap-overlay__text">
        <strong>Bootstrap failed</strong> on <strong>{targetLabel}</strong>: {errText}
        {retryError ? <div className="bootstrap-overlay__retry-error">{retryError}</div> : null}
      </div>
      <button
        type="button"
        className="btn btn--secondary"
        onClick={() => void onRetry()}
        disabled={retrying}
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

export default BootstrapStatusOverlay;
