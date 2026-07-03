// Wave 7.0.9 — live view of generator + bulk-ingest producers and bulk-loader
// queue health so operators know what "Stop generators" actually stopped.

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelCard } from "./PanelCard";
import {
  cancelBulkIngest,
  cancelGenerator,
  getActiveBulkIngestRuns,
  getActiveGeneratorRuns,
  getBulkLoadStatus,
  type ActiveBulkIngestRun,
  type ActiveGeneratorRun,
  type BulkLoadStatus,
} from "../lib/ingest";
import { pickBulkRunProgress } from "../lib/ingestRunState";

const POLL_MS = 2_000;
/** Treat bulk-loader as actively draining when flush rate exceeds this. */
const DRAIN_FLUSH_RPS_MIN = 50;

export interface ActiveJobsSnapshot {
  generatorRuns: ActiveGeneratorRun[];
  bulkRuns: ActiveBulkIngestRun[];
  bulkLoad: BulkLoadStatus | null;
  /** API-side producers still running (generator or bulk start). */
  hasActiveProducers: boolean;
  /** bulk-loader still flushing pending rows after producers stopped. */
  isDraining: boolean;
  /** Live pending rows (dispatcher in_flight summed across replicas). */
  pending: number;
  /** Lifetime rows written to Redis (sum of workers[].flushed). */
  flushedTotal: number;
  /** Observed bulk-loader write rate from flushed counter deltas. */
  flushRps: number;
}

function sumFlushed(load: BulkLoadStatus | null): number {
  if (!load?.workers?.length) return 0;
  return load.workers.reduce(
    (acc, w) => acc + (typeof w.flushed === "number" ? w.flushed : 0),
    0,
  );
}

function pendingRows(load: BulkLoadStatus | null): number {
  return load?.dispatcher?.in_flight ?? 0;
}

function buildSnapshot(
  generatorRuns: ActiveGeneratorRun[],
  bulkRuns: ActiveBulkIngestRun[],
  bulkLoad: BulkLoadStatus | null,
  flushRps: number,
): ActiveJobsSnapshot {
  const pending = pendingRows(bulkLoad);
  const flushedTotal = sumFlushed(bulkLoad);
  const hasActiveProducers = generatorRuns.length > 0 || bulkRuns.length > 0;
  const isDraining = !hasActiveProducers
    && (pending > 0 || flushRps >= DRAIN_FLUSH_RPS_MIN);
  return {
    generatorRuns,
    bulkRuns,
    bulkLoad,
    hasActiveProducers,
    isDraining,
    pending,
    flushedTotal,
    flushRps,
  };
}

function fmtProgress(done: number, total: number): string {
  if (total <= 0) return `${done.toLocaleString("en-US")} rows`;
  const pct = Math.min(100, Math.round((done / total) * 100));
  return `${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} (${pct}%)`;
}

/** Rows written to Redis for this run — phase-aware + monotonic across polls. */
function bulkRunProgressDone(
  run: ActiveBulkIngestRun,
  previous: number,
): number {
  return pickBulkRunProgress(run, previous);
}

export interface ActiveJobsCardProps {
  onSnapshot?: (snap: ActiveJobsSnapshot) => void;
  onRequestStopAll?: () => void;
  /** Bump to force an immediate refresh (e.g. after Stop generators). */
  refreshToken?: number;
}

export function ActiveJobsCard(props: ActiveJobsCardProps): JSX.Element {
  const { onSnapshot, onRequestStopAll, refreshToken = 0 } = props;
  const [snap, setSnap] = useState<ActiveJobsSnapshot>(() => buildSnapshot([], [], null, 0));
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const flushSampleRef = useRef<{ flushed: number; t: number } | null>(null);
  const bulkProgressRef = useRef<Map<string, number>>(new Map());

  const poll = useCallback(async () => {
    try {
      const [gen, bulk, load] = await Promise.all([
        getActiveGeneratorRuns().catch(() => ({ active: [] as ActiveGeneratorRun[] })),
        getActiveBulkIngestRuns().catch(() => ({ active: [] as ActiveBulkIngestRun[] })),
        getBulkLoadStatus().catch(() => null),
      ]);
      const flushedTotal = sumFlushed(load);
      const now = Date.now();
      let flushRps = 0;
      const prev = flushSampleRef.current;
      if (prev && now > prev.t) {
        const dt = (now - prev.t) / 1000;
        const delta = flushedTotal - prev.flushed;
        if (dt > 0 && delta > 0) flushRps = Math.round(delta / dt);
      }
      flushSampleRef.current = { flushed: flushedTotal, t: now };

      const activeBulkIds = new Set(bulk.active.map((r) => r.run_id));
      for (const id of bulkProgressRef.current.keys()) {
        if (!activeBulkIds.has(id)) bulkProgressRef.current.delete(id);
      }
      for (const r of bulk.active) {
        const prevDone = bulkProgressRef.current.get(r.run_id) ?? 0;
        const done = bulkRunProgressDone(r, prevDone);
        bulkProgressRef.current.set(r.run_id, done);
      }

      const next = buildSnapshot(gen.active, bulk.active, load, flushRps);
      setSnap(next);
      setError(null);
      onSnapshot?.(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) void poll(); };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [poll, refreshToken]);

  async function onCancelGenerator(runId: string): Promise<void> {
    setCancelling(runId);
    try {
      await cancelGenerator(runId);
      await poll();
    } finally {
      setCancelling(null);
    }
  }

  async function onCancelBulk(runId: string): Promise<void> {
    setCancelling(runId);
    try {
      await cancelBulkIngest(runId);
      await poll();
    } finally {
      setCancelling(null);
    }
  }

  const busy = snap.hasActiveProducers || snap.isDraining;
  const statusChip = snap.hasActiveProducers
    ? "active"
    : snap.isDraining
      ? "draining"
      : "idle";

  return (
    <PanelCard
      title="Active jobs"
      actions={
        onRequestStopAll ? (
          <button
            type="button"
            className="btn btn--danger"
            onClick={onRequestStopAll}
            data-testid="active-jobs-stop-all"
          >
            Stop all
          </button>
        ) : null
      }
    >
      <div className="active-jobs" data-testid="active-jobs-card" data-status={statusChip}>
        <p className="active-jobs__hint">
          Stream generator and bulk-ingest API jobs stop immediately. The bulk-loader may
          still flush <em>pending</em> rows to Redis — watch pending + flush rate below.
        </p>

        {error ? (
          <p className="active-jobs__error" role="alert">{error}</p>
        ) : null}

        {snap.hasActiveProducers ? (
          <div className="admin-table-wrap">
            <table className="admin-table" data-testid="active-jobs-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Run</th>
                  <th>Progress</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snap.generatorRuns.map((r) => (
                  <tr key={`gen-${r.run_id}`} data-testid={`active-job-gen-${r.run_id}`}>
                    <td>Stream generator</td>
                    <td><code>{r.run_id}</code></td>
                    <td>{fmtProgress(r.rows_done, r.rows_total)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        disabled={cancelling === r.run_id}
                        onClick={() => { void onCancelGenerator(r.run_id); }}
                      >
                        {cancelling === r.run_id ? "Stopping…" : "Stop"}
                      </button>
                    </td>
                  </tr>
                ))}
                {snap.bulkRuns.map((r) => (
                  <tr key={`bulk-${r.run_id}`} data-testid={`active-job-bulk-${r.run_id}`}>
                    <td>
                      Bulk ingest
                      {typeof r.workers === "number" ? ` · ${r.workers} workers` : ""}
                    </td>
                    <td><code>{r.run_id}</code></td>
                    <td>{fmtProgress(bulkProgressRef.current.get(r.run_id) ?? bulkRunProgressDone(r, 0), r.rows_total)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        disabled={cancelling === r.run_id}
                        onClick={() => { void onCancelBulk(r.run_id); }}
                      >
                        {cancelling === r.run_id ? "Stopping…" : "Stop"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="active-jobs__idle" data-testid="active-jobs-idle">
            No active generator or bulk-ingest jobs on the API.
          </p>
        )}

        <div className="active-jobs__loader" data-testid="active-jobs-bulk-loader">
          <span className="active-jobs__loader-label">Bulk-loader queue</span>
          <span>
            pending <strong data-testid="active-jobs-pending">{snap.pending.toLocaleString("en-US")}</strong>
            {" · "}
            flushing <strong data-testid="active-jobs-flush-rps">{snap.flushRps.toLocaleString("en-US")}</strong> rows/s
            {" · "}
            written <strong>{snap.flushedTotal.toLocaleString("en-US")}</strong> total
            {snap.bulkLoad?.throttled ? (
              <span className="active-jobs__warn"> · throttled</span>
            ) : null}
            {(snap.bulkLoad?.recent_429_count ?? 0) > 0 ? (
              <span className="active-jobs__warn">
                {" · "}
                {snap.bulkLoad!.recent_429_count} recent 429
                {(snap.bulkLoad!.recent_429_count ?? 0) === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
        </div>

        {snap.isDraining ? (
          <div className="active-jobs__drain" role="status" data-testid="active-jobs-draining">
            Producers stopped — bulk-loader is still writing to Redis
            {snap.pending > 0 ? ` (${snap.pending.toLocaleString("en-US")} pending)` : ""}
            {snap.flushRps > 0 ? ` at ~${snap.flushRps.toLocaleString("en-US")} rows/s` : ""}.
            Rows/sec on the chart tracks index growth until flush stops.
          </div>
        ) : null}

        {!busy && !error ? (
          <p className="active-jobs__ok" data-testid="active-jobs-healthy">Idle — safe to start a new run.</p>
        ) : null}
      </div>
    </PanelCard>
  );
}
