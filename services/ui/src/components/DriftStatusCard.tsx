// Wave 6.39.D — DriftStatusCard surfaces GET /admin/drift-status as a
// timeline table with a threshold header pill. Polls every 10 seconds so
// the operator can leave the Admin tab open and watch live drift results
// flow in without manually refreshing.

import { useEffect, useState } from "react";
import { PanelCard } from "./PanelCard";
import { getDriftStatus, type DriftStatusResponse, type DriftResult } from "../lib/admin";

const POLL_MS = 10_000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: DriftStatusResponse }
  | { kind: "error"; message: string };

function thresholdPct(t: number): string {
  if (!Number.isFinite(t)) return "—";
  return `${(t * 100).toFixed(1)}%`;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace("T", " ").replace(/\..*$/, "Z");
}

function Row({ r }: { r: DriftResult }) {
  return (
    <tr>
      <td>{fmtTs(r.ts)}</td>
      <td>{r.risk_class}</td>
      <td>{r.bucket}</td>
      <td>{r.sensitivity_type}</td>
      <td>{r.rollup_sum.toLocaleString("en-US")}</td>
      <td>{r.recomputed_sum.toLocaleString("en-US")}</td>
      <td>{fmtPct(r.drift_pct)}</td>
      <td>
        <span className={r.status === "drift" ? "pill pill--err" : "pill pill--ok"}>
          {r.status}
        </span>
      </td>
    </tr>
  );
}

export function DriftStatusCard() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getDriftStatus()
        .then((data) => { if (!cancelled) setState({ kind: "ready", data }); })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setState((prev) => prev.kind === "ready" ? prev : { kind: "error", message });
        });
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (state.kind === "loading") {
    return (
      <PanelCard title="Drift">
        <div className="admin-skeleton" role="status" aria-label="Loading drift status" />
      </PanelCard>
    );
  }
  if (state.kind === "error") {
    return (
      <PanelCard title="Drift">
        <div className="admin-error" role="alert">Failed to load drift status — {state.message}</div>
      </PanelCard>
    );
  }

  const { data } = state;
  return (
    <PanelCard title="Drift">
      <div className="admin-summary">
        <span data-testid="drift-threshold">
          Threshold: <strong>{thresholdPct(data.threshold_pct)}</strong>
        </span>
        <span>Checks: <strong>{data.results.length}</strong></span>
      </div>
      {data.results.length === 0 ? (
        <div className="admin-empty" data-testid="drift-status-empty" role="status">
          No drift checks yet — the drift detector job has not produced any samples.
        </div>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table" data-testid="drift-status-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Risk class</th>
                <th>Bucket</th>
                <th>Type</th>
                <th>Rollup</th>
                <th>Recomputed</th>
                <th>Drift</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((r, i) => <Row key={`${r.ts}|${r.risk_class}|${r.bucket}|${r.sensitivity_type}|${i}`} r={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  );
}
