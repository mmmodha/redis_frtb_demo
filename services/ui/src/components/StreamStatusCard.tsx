// Wave 6.39.D — StreamStatusCard surfaces GET /admin/stream-status (xlen,
// maxlen, peak rate, retention now / at cap). Polls every 5 seconds because
// stream depth is the most volatile signal in the admin set.

import { useEffect, useState } from "react";
import { PanelCard } from "./PanelCard";
import { MetricTile } from "./MetricTile";
import { getStreamStatus, type StreamStatusResponse } from "../lib/admin";

const POLL_MS = 5_000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: StreamStatusResponse }
  | { kind: "error"; message: string };

export function StreamStatusCard() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getStreamStatus()
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
      <PanelCard title="Stream Status">
        <div className="admin-skeleton" role="status" aria-label="Loading stream status" />
      </PanelCard>
    );
  }
  if (state.kind === "error") {
    return (
      <PanelCard title="Stream Status">
        <div className="admin-error" role="alert">Failed to load stream status — {state.message}</div>
      </PanelCard>
    );
  }

  const { data } = state;
  return (
    <PanelCard title="Stream Status">
      <div className="admin-summary">
        <span>Stream: <code>{data.stream_key}</code></span>
      </div>
      <div className="metric-grid" data-testid="stream-status-metrics">
        <MetricTile label="xlen" value={data.xlen.toLocaleString("en-US")} status="live" />
        <MetricTile label="maxlen" value={data.maxlen.toLocaleString("en-US")} status="derived" />
        <MetricTile label="Peak rate" value={data.peak_rate_per_sec.toLocaleString("en-US")} unit="msg/s" status="live" />
        <MetricTile label="Retention now" value={data.retention_hours_now.toFixed(1)} unit="h" status="live" />
        <MetricTile label="Retention @ cap" value={data.retention_hours_at_cap.toFixed(1)} unit="h" status="derived" />
      </div>
    </PanelCard>
  );
}
