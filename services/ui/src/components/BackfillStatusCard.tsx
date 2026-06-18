// Wave 6.39.D — BackfillStatusCard surfaces GET /admin/backfill-status.
// The endpoint is a reserved stub in 6.39.B (always returns status
// "not-implemented") but the card renders both shapes so it lights up
// automatically when the backend is wired in a later wave.

import { useEffect, useState } from "react";
import { PanelCard } from "./PanelCard";
import { getBackfillStatus, type BackfillStatusResponse } from "../lib/admin";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: BackfillStatusResponse }
  | { kind: "error"; message: string };

function pct(completed: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

function etaLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function BackfillStatusCard() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    getBackfillStatus()
      .then((data) => { if (!cancelled) setState({ kind: "ready", data }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => { cancelled = true; };
  }, []);

  if (state.kind === "loading") {
    return (
      <PanelCard title="Backfill">
        <div className="admin-skeleton" role="status" aria-label="Loading backfill status" />
      </PanelCard>
    );
  }
  if (state.kind === "error") {
    return (
      <PanelCard title="Backfill">
        <div className="admin-error" role="alert">Failed to load backfill status — {state.message}</div>
      </PanelCard>
    );
  }

  const { data } = state;
  if (data.status === "not-implemented") {
    return (
      <PanelCard title="Backfill">
        <div className="admin-stub" data-testid="backfill-stub-banner" role="status">
          Backfill is a reserved endpoint — not yet implemented. Use the SBM Calculator
          to materialise rollups on demand, or wait for a scheduled snapshot.
        </div>
      </PanelCard>
    );
  }

  const progressPct = pct(data.completed, data.total);
  return (
    <PanelCard title="Backfill">
      <div className="admin-summary" data-testid="backfill-progress">
        <span><strong>{data.completed.toLocaleString("en-US")}</strong> of {data.total.toLocaleString("en-US")} buckets</span>
        <span>In flight: <strong>{data.in_flight}</strong></span>
        <span>Failed: <strong>{data.failed}</strong></span>
        <span>ETA: <strong>{etaLabel(data.eta_ms)}</strong></span>
        <span className="pill">{data.status}</span>
      </div>
      <div
        className="admin-progress-bar"
        data-testid="backfill-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPct}
      >
        <div className="admin-progress-bar__fill" style={{ width: `${progressPct}%` }} />
      </div>
    </PanelCard>
  );
}
