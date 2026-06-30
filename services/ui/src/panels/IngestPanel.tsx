import { useCallback, useEffect, useRef, useState } from "react";
import { BulkLoaderTargetBanner, isBulkLoaderTargetDivergent } from "../components/ingest/BulkLoaderTargetBanner";
import { IngestAdminFooter } from "../components/ingest/IngestAdminFooter";
import { IngestRunHistoryCard } from "../components/ingest/IngestRunHistoryCard";
import { IngestRunZone } from "../components/ingest/IngestRunZone";
import { IngestClusterTiles } from "../components/ingest/IngestClusterTiles";
import { useIngestClusterStats } from "../hooks/useIngestClusterStats";
import { useIngestRun } from "../hooks/useIngestRun";
import { useIngestRunHistory } from "../hooks/useIngestRunHistory";
import { deriveIngestPageMode } from "../lib/ingestPageLayout";
import { pickHistoryRowsWritten } from "../lib/ingestRunState";
import {
  flushDb,
  fetchLiveDbKeyCount,
  getBulkIngestRun,
  getHostInfo,
  preflightAndRebuildIfNeeded,
  startBulkIngest,
  stopAllRuns,
  type HostInfo,
} from "../lib/ingest";
import {
  clearLastRunKeysAdded,
  keysAddedFromBaseline,
  readLastRunKeysAdded,
  writeLastRunKeysAdded,
} from "../lib/ingestLastRunKeys";
import {
  entryFromCompletedRun,
  saveLocalRunHistoryEntry,
} from "../lib/ingestRunHistory";
import {
  RUN_PRESETS,
  suggestWorkersForPreset,
  type RunPresetKey,
} from "../lib/ingest-presets";

export {
  RUN_PRESETS,
  RUN_PRESET_ORDER,
  suggestWorkersForPreset,
  type RunPresetKey,
  type RunPreset,
} from "../lib/ingest-presets";
export { isBulkLoaderTargetDivergent } from "../components/ingest/BulkLoaderTargetBanner";

function FlushDbConfirmModal(props: {
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { onCancel, onConfirm } = props;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Flush DB confirmation">
      <div className="dialog sanity-modal--block" data-testid="flush-db-modal">
        <h2>Flush the active Redis database?</h2>
        <div className="sanity-modal__body">
          This will delete all sensitivities. The index will be empty until the next ingest.
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel} data-testid="flush-db-cancel">Cancel</button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} data-testid="flush-db-confirm">Confirm</button>
        </div>
      </div>
    </div>
  );
}

function StopAllRunsConfirmModal(props: {
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { onCancel, onConfirm } = props;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Stop all runs confirmation">
      <div className="dialog sanity-modal--block" data-testid="stop-all-runs-modal">
        <h2>Stop all ingest runs?</h2>
        <div className="sanity-modal__body">
          Cancels all bulk-loader producers. Use Flush DB to wipe Redis.
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel} data-testid="stop-all-runs-cancel">Cancel</button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} data-testid="stop-all-runs-confirm">Confirm</button>
        </div>
      </div>
    </div>
  );
}

export function IngestPanel(): JSX.Element {
  const { view: runView, beginRun, cancelRun } = useIngestRun();
  const [presetKey, setPresetKey] = useState<RunPresetKey>("quick");
  const [workers, setWorkers] = useState(() => suggestWorkersForPreset("quick"));
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [presetInflight, setPresetInflight] = useState(false);
  const cluster = useIngestClusterStats({
    liveKeys: runView.phase === "running" || runView.phase === "summary" || presetInflight,
    persistedKeysAtRunStart: runView.keysAtRunStart,
  });
  const reloadCluster = cluster.reloadAll;
  const [presetStep, setPresetStep] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [flushPending, setFlushPending] = useState(false);
  const [flushBusy, setFlushBusy] = useState(false);
  const [flushBanner, setFlushBanner] = useState<string | null>(null);
  const [stopAllPending, setStopAllPending] = useState(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const [stopAllBanner, setStopAllBanner] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const history = useIngestRunHistory(historyRefresh);
  const [lastRunKeysAdded, setLastRunKeysAdded] = useState<number | null>(
    () => readLastRunKeysAdded()?.keys_added ?? null,
  );
  const capturedSummaryRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    void getHostInfo().then(setHostInfo).catch(() => setHostInfo(null));
  }, []);

  useEffect(() => {
    if (runView.phase === "hidden") {
      capturedSummaryRunIdRef.current = null;
      return;
    }
    if (runView.phase !== "summary" || !runView.runId || runView.keysAtRunStart == null) return;
    if (capturedSummaryRunIdRef.current === runView.runId) return;
    capturedSummaryRunIdRef.current = runView.runId;
    const runId = runView.runId;
    const keysBaseline = runView.keysAtRunStart;

    void (async () => {
      let added = keysAddedFromBaseline(cluster.sens.count, keysBaseline);
      try {
        const liveCount = await fetchLiveDbKeyCount();
        added = keysAddedFromBaseline(liveCount, keysBaseline) ?? added;
      } catch {
        /* keep tile count fallback */
      }
      const keysAdded = added ?? Math.max(0, runView.written);
      writeLastRunKeysAdded({
        run_id: runId,
        keys_added: keysAdded,
        completed_at: Date.now(),
      });
      setLastRunKeysAdded(keysAdded);
    })();
  }, [
    runView.phase,
    runView.runId,
    runView.keysAtRunStart,
    runView.written,
    cluster.sens.count,
  ]);

  useEffect(() => {
    if (runView.phase !== "summary" || !runView.runId) return undefined;
    reloadCluster();
    const runId = runView.runId;
    const timer = window.setTimeout(() => {
      setHistoryRefresh((n) => n + 1);
      void (async () => {
        try {
          const bulk = await getBulkIngestRun(runId);
          if (!bulk || bulk.status === "running") return;
          const status = bulk.status === "cancelled" || bulk.status === "error" || bulk.status === "done"
            ? bulk.status
            : "done";
          saveLocalRunHistoryEntry(entryFromCompletedRun({
            runId: bulk.run_id,
            status,
            rowsTotal: bulk.rows_total,
            rowsWritten: pickHistoryRowsWritten(bulk, runView.written),
            rowsSent: bulk.rows_sent,
            durationMs: bulk.ms,
            startedAtIso: bulk.started_at_iso,
            bulkLoaderBase: bulk.bulk_loader_base,
            workers: bulk.workers ?? 1,
            error: bulk.error,
          }));
          setHistoryRefresh((n) => n + 1);
        } catch { /* history refresh is best-effort */ }
      })();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [runView.phase, runView.runId, runView.written, reloadCluster]);

  const ingestTargetLabel = hostInfo?.target_label ?? null;
  const targetDivergent = isBulkLoaderTargetDivergent(hostInfo, ingestTargetLabel);
  const pageMode = deriveIngestPageMode(runView.phase, presetInflight);

  const onPresetChange = useCallback((key: RunPresetKey) => {
    setPresetKey(key);
    setWorkers(suggestWorkersForPreset(key));
  }, []);

  const onStartPreset = useCallback(async () => {
    const p = RUN_PRESETS[presetKey];
    setPresetInflight(true);
    setPresetError(null);
    setPresetStep("Checking indexes…");
    try {
      const { preflight: pf, rebuilt } = await preflightAndRebuildIfNeeded();
      if (pf.ok === false) {
        setPresetError("Pre-flight failed after rebuild — check Admin for details.");
        setPresetStep(null);
        return;
      }
      if (rebuilt) setPresetStep("Indexes repaired.");
      setPresetStep(`Starting ${p.label}…`);
      const keysBaseline = await cluster.captureKeysBaseline();
      const start = await startBulkIngest({ rows: p.rows, workers });
      beginRun(start.run_id, start.rows_total, start.started_at_iso, keysBaseline);
      setPresetStep(null);
    } catch (e) {
      setPresetError((e as Error).message);
      setPresetStep(null);
    } finally {
      setPresetInflight(false);
    }
  }, [presetKey, workers, beginRun, cluster.captureKeysBaseline]);

  const onFlushConfirm = useCallback(async () => {
    setFlushPending(false);
    setFlushBusy(true);
    setPanelError(null);
    try {
      if (runView.phase === "running" && runView.runId) {
        try { await cancelRun(); } catch { /* tolerate */ }
      }
      try { await stopAllRuns(); } catch { /* tolerate */ }
      const r = await flushDb();
      if (r.bootstrap && !r.bootstrap.ok) {
        setPanelError(`Flush failed: bootstrap ${r.bootstrap.error ?? "failed"}`);
      } else {
        const banner = r.bootstrap?.ok
          ? `Flushed in ${r.ms}ms · indexes rebuilt`
          : `Flushed in ${r.ms}ms`;
        setFlushBanner(banner);
        window.setTimeout(() => setFlushBanner(null), 4000);
      }
      clearLastRunKeysAdded();
      setLastRunKeysAdded(null);
      cluster.reloadAll();
    } catch (e) {
      setPanelError((e as Error).message);
    } finally {
      setFlushBusy(false);
    }
  }, [runView, cancelRun, reloadCluster]);

  const onStopAllConfirm = useCallback(async () => {
    setStopAllPending(false);
    setStopAllBusy(true);
    setPanelError(null);
    try {
      const r = await stopAllRuns();
      const bulkCount = r.bulk_cancelled ?? r.bulk_run_ids?.length ?? 0;
      const banner = bulkCount === 0
        ? "No active runs."
        : `Stopped ${bulkCount} bulk ingest run${bulkCount === 1 ? "" : "s"}.`;
      setStopAllBanner(banner);
      window.setTimeout(() => setStopAllBanner(null), 4000);
    } catch (e) {
      setPanelError((e as Error).message);
    } finally {
      setStopAllBusy(false);
    }
  }, []);

  return (
    <div className="panel ingest-panel">
      <header className="panel__header">
        <h1>Ingest</h1>
        <p className="panel__subhead">Load synthetic sensitivities into Redis via the bulk loader.</p>
      </header>

      <IngestClusterTiles
        targetLabel={ingestTargetLabel}
        memory={cluster.memory}
        sens={cluster.sens}
        runPhase={runView.phase}
        keysAtRunStart={runView.keysAtRunStart}
        lastRunKeysAdded={lastRunKeysAdded}
        runWritten={runView.phase !== "hidden" ? runView.written : null}
      />

      <BulkLoaderTargetBanner hostInfo={hostInfo} ingestTargetLabel={ingestTargetLabel} />

      {panelError ? (
        <div className="panel__error" role="alert">{panelError}</div>
      ) : null}

      <IngestRunZone
        mode={pageMode}
        runPhase={runView.phase}
        presetKey={presetKey}
        onPresetChange={onPresetChange}
        workers={workers}
        onWorkersChange={setWorkers}
        hostInfo={hostInfo}
        targetBlocked={targetDivergent}
        inflight={presetInflight}
        step={presetStep}
        error={presetError}
        onStart={() => { void onStartPreset(); }}
        written={runView.written}
        total={runView.total}
        writeRps={runView.writeRps}
        stallHint={runView.stallHint}
        summaryText={runView.summaryText}
        onCancel={() => { void cancelRun(); }}
      />

      <IngestAdminFooter
        flushBusy={flushBusy}
        stopAllBusy={stopAllBusy}
        flushBanner={flushBanner}
        stopAllBanner={stopAllBanner}
        onFlushClick={() => setFlushPending(true)}
        onStopAllClick={() => setStopAllPending(true)}
      />

      <IngestRunHistoryCard
        runs={history.runs}
        expandedId={history.expandedId}
        onExpandedChange={history.setExpandedId}
      />

      {flushPending ? (
        <FlushDbConfirmModal onCancel={() => setFlushPending(false)} onConfirm={() => { void onFlushConfirm(); }} />
      ) : null}
      {stopAllPending ? (
        <StopAllRunsConfirmModal onCancel={() => setStopAllPending(false)} onConfirm={() => { void onStopAllConfirm(); }} />
      ) : null}
    </div>
  );
}
