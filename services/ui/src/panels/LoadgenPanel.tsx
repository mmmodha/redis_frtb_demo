// "Concurrent Load" panel — Wave 4.2.
//
// Drives the loadgen service from the browser: pick concurrency, hit Start,
// watch live latency tiles (p50/p95/p99 + throughput) fed by the SSE stream
// off /loadgen/metrics. Stop button tears down workers cleanly. The 200-user
// p99<500ms acceptance line ships as a callout pill so the presenter can
// point at it on screen during demo step 8.

import { useCallback, useEffect, useRef, useState } from "react";
import { EnterpriseCallout, MetricTile, PanelCard } from "../components";
import {
  getLoadgenStatus,
  startLoadgen,
  stopLoadgen,
  subscribeMetrics,
  type LoadgenMetricsFrame,
} from "../lib/loadgen";

const DEFAULT_CONCURRENCY = 200;
const DEFAULT_DURATION_SEC = 300;

function fmtNum(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toString();
}

export function LoadgenPanel() {
  const [concurrency, setConcurrency] = useState<number>(DEFAULT_CONCURRENCY);
  const [running, setRunning] = useState(false);
  const [frame, setFrame] = useState<LoadgenMetricsFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disposerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getLoadgenStatus()
      .then((s) => { if (!cancelled) setRunning(Boolean(s.running)); })
      .catch(() => { /* status probe is best-effort */ });
    return () => { cancelled = true; };
  }, []);

  const closeStream = useCallback(() => {
    if (disposerRef.current) {
      disposerRef.current();
      disposerRef.current = null;
    }
  }, []);

  useEffect(() => () => closeStream(), [closeStream]);

  const openStream = useCallback(() => {
    closeStream();
    disposerRef.current = subscribeMetrics((f) => setFrame(f));
  }, [closeStream]);

  const onStart = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await startLoadgen({
        concurrency,
        duration_sec: DEFAULT_DURATION_SEC,
        mix: { pivot: 0.5, calc: 0.5 },
      });
      setRunning(true);
      openStream();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [concurrency, openStream]);

  const onStop = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await stopLoadgen();
      setRunning(false);
      closeStream();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [closeStream]);

  const p50 = frame?.latency.p50 ?? 0;
  const p95 = frame?.latency.p95 ?? 0;
  const p99 = frame?.latency.p99 ?? 0;
  const rps = frame?.throughput_rps ?? 0;
  const total = frame?.total_requests ?? 0;
  const errors = frame?.errors ?? 0;

  return (
    <PanelCard title="Concurrent Load">
      <EnterpriseCallout signal="Functions">
        Drives a configurable workforce of pivot + calc clients against the
        api so observability tiles light up under realistic load.
        <strong> 200 concurrent users · target p99 &lt; 500ms.</strong>
      </EnterpriseCallout>

      <div className="loadgen-controls">
        <label htmlFor="loadgen-concurrency">Concurrency</label>
        <input
          id="loadgen-concurrency"
          type="number"
          min={1}
          max={1000}
          value={concurrency}
          onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value) || 1))}
          disabled={running || busy}
        />
        {!running ? (
          <button type="button" onClick={() => void onStart()} disabled={busy}>
            Start
          </button>
        ) : (
          <button type="button" onClick={() => void onStop()} disabled={busy}>
            Stop
          </button>
        )}
        <span className="loadgen-controls__hint">
          50/50 mix of <code>/pivot</code> + <code>/calc/sbm</code>
        </span>
      </div>

      {error ? (
        <div className="loadgen-error" role="alert">{error}</div>
      ) : null}

      <div className="metric-grid">
        <MetricTile label="Throughput" value={fmtNum(rps)} unit="req/s" status={running ? "live" : "stale"} />
        <MetricTile label="p50 latency" value={fmtMs(p50)} unit="ms" status={running ? "live" : "stale"} />
        <MetricTile label="p95 latency" value={fmtMs(p95)} unit="ms" status={running ? "live" : "stale"} />
        <MetricTile label="p99 latency" value={fmtMs(p99)} unit="ms" status={running ? "live" : "stale"} />
        <MetricTile label="Total requests" value={fmtNum(total)} unit="reqs" status={running ? "live" : "stale"} />
        <MetricTile label="Errors" value={fmtNum(errors)} unit="reqs" status={running ? "live" : "stale"} />
      </div>
    </PanelCard>
  );
}
