// Wave 7.0.9 — IngestCapacityTestCard runs POST /admin/ingest-capacity-test
// and surfaces worker sweep results + recommended worker count.

import { useCallback, useState } from "react";
import { PanelCard } from "./PanelCard";
import {
  postIngestCapacityTest,
  type CapacityTestResult,
  type CapacityStepVerdict,
} from "../lib/admin";

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ready"; data: CapacityTestResult }
  | { kind: "error"; message: string };

function fmtRps(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function verdictLabel(v: CapacityStepVerdict): string {
  if (v === "optimal") return "balanced";
  if (v === "saturated") return "saturated";
  return "headroom";
}

function bottleneckLabel(b: CapacityTestResult["bottleneck"]): string {
  switch (b) {
    case "bulk_loader_queue": return "Bulk-loader queue";
    case "redis_write": return "Redis write ceiling";
    case "under_utilized": return "Headroom";
    default: return "Balanced";
  }
}

export function IngestCapacityTestCard() {
  const [state, setState] = useState<State>({ kind: "idle" });

  const onRun = useCallback(() => {
    setState({ kind: "running" });
    void postIngestCapacityTest()
      .then((data) => setState({ kind: "ready", data }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
  }, []);

  return (
    <PanelCard title="Ingest capacity test">
      <p className="admin-stub">
        Runs a short bulk-ingest benchmark on the active Redis target and recommends
        a worker count. Saturated steps require 429s from the bulk-loader. Each step
        writes ~50k rows — allow 1–3 minutes. Stop any running ingest or generator first.
      </p>
      <div className="admin-form__actions" style={{ marginBottom: "var(--grid)" }}>
        <button
          type="button"
          className="ingest-run-toolbar__cta"
          onClick={onRun}
          disabled={state.kind === "running"}
          data-testid="ingest-capacity-run"
        >
          {state.kind === "running" ? "Running benchmark…" : "Run capacity test"}
        </button>
      </div>

      {state.kind === "running" && (
        <div className="admin-skeleton" role="status" data-testid="ingest-capacity-running">
          Sweeping worker counts…
        </div>
      )}

      {state.kind === "error" && (
        <div className="admin-error" role="alert" data-testid="ingest-capacity-error">
          {state.message}
        </div>
      )}

      {state.kind === "ready" && (
        <div data-testid="ingest-capacity-result">
          <div className="admin-summary" data-testid="ingest-capacity-summary">
            <div>
              Target: <strong>{state.data.target_label ?? "—"}</strong>
            </div>
            <div>
              Recommended workers:{" "}
              <strong data-testid="ingest-capacity-recommended">{state.data.recommended_workers}</strong>
            </div>
            <div>
              Recommended bulk-loader replicas:{" "}
              <strong data-testid="ingest-capacity-replicas">
                {state.data.deployment.recommended_bulk_loader_replicas}
              </strong>
              {state.data.deployment.bulk_loader_replicas
                !== state.data.deployment.recommended_bulk_loader_replicas && (
                <span className="admin-list__secondary">
                  {" "}
                  (currently {state.data.deployment.bulk_loader_replicas})
                </span>
              )}
            </div>
            <div>
              Bottleneck: <strong>{bottleneckLabel(state.data.bottleneck)}</strong>
            </div>
            <div>
              Host: {state.data.deployment.cores} cores · pool{" "}
              {state.data.deployment.bulk_loader_pool_size}
              {" · "}
              {state.data.deployment.bulk_loader_replicas} bulk-loader replica
              {state.data.deployment.bulk_loader_replicas === 1 ? "" : "s"}
              {state.data.deployment.shards != null
                ? ` · ${state.data.deployment.shards} shards`
                : ""}
              {" · "}
              {Math.round(state.data.total_ms / 1000)}s total
            </div>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table" data-testid="ingest-capacity-table">
              <thead>
                <tr>
                  <th>Workers</th>
                  <th>Gen RPS</th>
                  <th>Write RPS</th>
                  <th>429 peak</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {state.data.steps.map((s) => (
                  <tr key={s.workers} data-testid={`ingest-capacity-row-${s.workers}`}>
                    <td>{s.workers}</td>
                    <td>{fmtRps(s.gen_rps)}</td>
                    <td>{fmtRps(s.write_rps)}</td>
                    <td>{s.recent_429_max}</td>
                    <td>{verdictLabel(s.verdict)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="admin-list">
            {state.data.notes.map((note) => (
              <li key={note} className="admin-list__item">
                <span className="admin-list__secondary">{note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </PanelCard>
  );
}
