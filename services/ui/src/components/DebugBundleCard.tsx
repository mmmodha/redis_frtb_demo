import { useCallback, useState } from "react";
import { PanelCard } from "./PanelCard";
import { getDebugBundle, type DebugBundleResponse } from "../lib/admin";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: DebugBundleResponse }
  | { kind: "error"; message: string };

export function DebugBundleCard(): JSX.Element {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const onFetch = useCallback(() => {
    setState({ kind: "loading" });
    void getDebugBundle()
      .then((data) => setState({ kind: "ready", data }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
  }, []);

  const onCopy = useCallback(async () => {
    if (state.kind !== "ready") return;
    const text = JSON.stringify(state.data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, [state]);

  const onDownload = useCallback(() => {
    if (state.kind !== "ready") return;
    const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frtb-debug-${state.data.generated_at.replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [state]);

  return (
    <div id="diagnostics">
    <PanelCard title="Run diagnostics">
      <p className="admin-stub">
        One-click snapshot of cluster health, ingest jobs, calc progress, backpressure,
        and recent errors — paste into Slack or attach to an incident ticket.
      </p>
      <div className="admin-form__actions" style={{ marginBottom: "var(--grid)" }}>
        <button
          type="button"
          className="ingest-run-toolbar__cta"
          onClick={onFetch}
          disabled={state.kind === "loading"}
          data-testid="debug-bundle-fetch"
        >
          {state.kind === "loading" ? "Collecting…" : "Collect diagnostics"}
        </button>
        {state.kind === "ready" ? (
          <>
            <button type="button" className="btn" onClick={() => { void onCopy(); }} data-testid="debug-bundle-copy">
              {copied ? "Copied" : "Copy JSON"}
            </button>
            <button type="button" className="btn btn--secondary" onClick={onDownload} data-testid="debug-bundle-download">
              Download
            </button>
          </>
        ) : null}
      </div>

      {state.kind === "error" ? (
        <div className="admin-error" role="alert" data-testid="debug-bundle-error">{state.message}</div>
      ) : null}

      {state.kind === "ready" ? (
        <div className="debug-bundle-summary" data-testid="debug-bundle-summary">
          <p>
            <strong>Target:</strong>{" "}
            {state.data.target ? `${state.data.target.label} (${state.data.target.host}:${state.data.target.port})` : "none"}
            {" · "}
            <strong>Bootstrap:</strong> {state.data.bootstrap.phase}
            {state.data.backpressure ? (
              <>
                {" · "}
                <strong>Heavy pool:</strong>{" "}
                {state.data.backpressure.heavy_inflight}/{state.data.backpressure.heavy_limit} in-flight
              </>
            ) : null}
            {" · "}
            <strong>Calc jobs:</strong> {state.data.calc.active_jobs.length} active
            {" · "}
            <strong>Errors:</strong> {state.data.recent_errors.length} recent
          </p>
          <pre className="debug-bundle-pre" data-testid="debug-bundle-pre">
            {JSON.stringify(state.data, null, 2)}
          </pre>
        </div>
      ) : null}
    </PanelCard>
    </div>
  );
}
