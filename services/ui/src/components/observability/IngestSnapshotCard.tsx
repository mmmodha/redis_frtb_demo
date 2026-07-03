import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PanelCard } from "../PanelCard";
import { getIngestSnapshot, type IngestSnapshot } from "../../lib/ingest";
import { pickBulkRunProgress } from "../../lib/ingestRunState";

const POLL_MS = 2_000;

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

export function IngestSnapshotCard(): JSX.Element {
  const [snap, setSnap] = useState<IngestSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef<Map<string, number>>(new Map());
  const [displayWritten, setDisplayWritten] = useState<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const data = await getIngestSnapshot();
      setSnap(data);
      setError(null);
      const focusedRun = data.focused_run_id
        ? data.runs.find((r) => r.run_id === data.focused_run_id) ?? data.runs[0]
        : data.runs[0];
      if (focusedRun) {
        const prev = progressRef.current.get(focusedRun.run_id) ?? 0;
        const done = pickBulkRunProgress(focusedRun, prev);
        progressRef.current.set(focusedRun.run_id, done);
        setDisplayWritten(done);
        // #region agent log
        fetch('http://127.0.0.1:7607/ingest/7ff27258-4498-4d23-9f58-aa9dac097748',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'fed362'},body:JSON.stringify({sessionId:'fed362',location:'IngestSnapshotCard.tsx:poll',message:'snapshot progress tick',data:{runId:focusedRun.run_id,rows_sent:focusedRun.rows_sent,rows_written:focusedRun.rows_written,phase:focusedRun.phase,prev,done},timestamp:Date.now(),hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
      } else {
        setDisplayWritten(null);
      }
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

  const focused = snap?.focused_run_id
    ? snap.runs.find((r) => r.run_id === snap.focused_run_id) ?? snap.runs[0]
    : snap?.runs[0];

  return (
    <PanelCard
      title="Ingest snapshot"
      actions={<Link to="/ingest" className="btn btn--secondary">Open Ingest</Link>}
    >
      <div className="obs-ingest-snap" data-testid="ingest-snapshot-card">
        {error ? <p className="obs-ingest-snap__error" role="alert">{error}</p> : null}
        {!snap ? (
          <p className="obs-ingest-snap__loading" role="status">Loading ingest snapshot…</p>
        ) : (
          <>
            <div className="obs-stat-row" data-testid="ingest-snapshot-loader">
              <div className="obs-stat">
                <span className="obs-stat__label">Queue pending</span>
                <span className="obs-stat__value">{fmt(snap.loader.in_flight)}</span>
              </div>
              <div className="obs-stat">
                <span className="obs-stat__label">Flush rate</span>
                <span className="obs-stat__value">{fmt(snap.loader.flush_rps)}<span className="obs-stat__unit"> rows/s</span></span>
              </div>
              <div className="obs-stat">
                <span className="obs-stat__label">Written</span>
                <span className="obs-stat__value">{fmt(snap.loader.flushed_total)}</span>
              </div>
            </div>
            {(snap.loader.throttled || (snap.loader.recent_429_count ?? 0) > 0) ? (
              <div className="obs-ingest-snap__alerts">
                {snap.loader.throttled ? <span className="obs-pill-warn">Throttled</span> : null}
                {(snap.loader.recent_429_count ?? 0) > 0 ? (
                  <span className="obs-pill-warn">{snap.loader.recent_429_count} recent 429</span>
                ) : null}
              </div>
            ) : null}
            {focused ? (
              <div className="obs-ingest-snap__run" data-testid="ingest-snapshot-focused-run">
                <span className={`pill pill--${focused.status === "running" ? "ok" : "muted"}`}>{focused.status}</span>
                <code className="obs-ingest-snap__run-id">{focused.run_id}</code>
                <span className="obs-ingest-snap__run-meta">
                  {fmt(displayWritten ?? focused.rows_written)} / {fmt(focused.rows_total)} rows
                  {" · "}
                  {fmt(focused.rows_per_sec_write)} rows/s write
                </span>
                {focused.error ? <span className="obs-ingest-snap__warn">{focused.error}</span> : null}
              </div>
            ) : (
              <p className="obs-ingest-snap__idle" data-testid="ingest-snapshot-idle">No active ingest run.</p>
            )}
          </>
        )}
      </div>
    </PanelCard>
  );
}
