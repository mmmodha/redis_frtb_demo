// Wave 6.39.D — SnapshotsCard surfaces GET /admin/snapshots as a vertical
// list of recent snapshot runs (timestamp + key_count). Polls every 30s.

import { useEffect, useState } from "react";
import { PanelCard } from "./PanelCard";
import { getSnapshots, type SnapshotsResponse } from "../lib/admin";

const POLL_MS = 30_000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: SnapshotsResponse }
  | { kind: "error"; message: string };

function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace("T", " ").replace(/\..*$/, "Z");
}

export function SnapshotsCard() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getSnapshots()
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
      <PanelCard title="Snapshots">
        <div className="admin-skeleton" role="status" aria-label="Loading snapshots" />
      </PanelCard>
    );
  }
  if (state.kind === "error") {
    return (
      <PanelCard title="Snapshots">
        <div className="admin-error" role="alert">Failed to load snapshots — {state.message}</div>
      </PanelCard>
    );
  }

  const { snapshots } = state.data;
  if (snapshots.length === 0) {
    return (
      <PanelCard title="Snapshots">
        <div className="admin-empty" data-testid="snapshots-empty" role="status">
          No snapshots yet — the snapshot job has not produced any runs.
        </div>
      </PanelCard>
    );
  }

  return (
    <PanelCard title="Snapshots">
      <ul className="admin-list" data-testid="snapshots-list">
        {snapshots.map((s, i) => (
          <li key={`${s.ts}|${i}`} className="admin-list__item">
            <span className="admin-list__primary">{fmtTs(s.ts)}</span>
            <span className="admin-list__secondary">
              <strong>{s.key_count.toLocaleString("en-US")}</strong> keys
            </span>
          </li>
        ))}
      </ul>
    </PanelCard>
  );
}
