import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PanelCard } from "../components/PanelCard";
import { MetricTile } from "../components/MetricTile";
import { MetricHistoryModal } from "../components/MetricHistoryModal";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { LastCalcCard } from "../components/LastCalcCard";
import { ActiveJobsCard } from "../components/ActiveJobsCard";
import { KeysSampleModal } from "../components/KeysSampleModal";
import { IngestSnapshotCard } from "../components/observability/IngestSnapshotCard";
import { IngestRunsCompactCard } from "../components/observability/IngestRunsCompactCard";
import { CalcHealthStrip } from "../components/observability/CalcHealthStrip";
import { ObservabilityOpsBanner } from "../components/observability/ObservabilityOpsBanner";
import {
  getObservabilityDebug,
  type ObservabilityDebugResponse,
  type ObservabilityKeysResponse,
  type ObservabilityMemoryResponse,
  type RecentCalcRun,
} from "../lib/api";
import { stopAllRuns } from "../lib/ingest";
import {
  OBS_REFRESH_OPTIONS,
  useObservabilityRefresh,
} from "../hooks/useObservabilityRefresh";
import { useMetricHistory, RETENTION_MS, type MetricName } from "../hooks/useMetricHistory";
import {
  formatBytesCompact,
  memoryBarLevel,
  memoryUsagePct,
  resolveMemoryCapBytes,
} from "../lib/ingestMemoryDisplay";
import type { MetricStatus } from "../components/MetricTile";

interface ObservabilityData {
  keys: ObservabilityKeysResponse;
  memory: ObservabilityMemoryResponse;
  indexCount: number;
  indexRefreshing: boolean;
  recent: RecentCalcRun[];
  bootstrap: ObservabilityDebugResponse["bootstrap"];
}

type Status =
  | { kind: "loading" }
  | { kind: "ready"; data: ObservabilityData }
  | { kind: "degraded" }
  | { kind: "error"; message: string };

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function cadenceLabel(cadenceMs: number): string {
  return cadenceMs === 0 ? "Off" : `${cadenceMs / 1000}s`;
}

export function humanizeSeconds(s: number): string {
  const n = Math.max(0, Math.floor(s));
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function Observability() {
  const { cadenceMs, setCadenceMs } = useObservabilityRefresh();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [pulseKey, setPulseKey] = useState<number>(0);
  const [inFlight, setInFlight] = useState<boolean>(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const inFlightRef = useRef<boolean>(false);

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const debug = await getObservabilityDebug(10);
      setStatus({
        kind: "ready",
        data: {
          keys: debug.keys,
          memory: debug.memory,
          indexCount: debug.index_count.count,
          indexRefreshing: debug.index_count.refreshing,
          recent: debug.calc_recent.items,
          bootstrap: debug.bootstrap,
        },
      });
      setLastError(null);
      setLastFetchAt(Date.now());
      setNow(Date.now());
      setPulseKey((k) => k + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isBusy = msg.includes("503") || /busy|calculation/i.test(msg);
      setStatus((prev) => {
        if (prev.kind === "ready") return prev;
        if (isBusy) return { kind: "degraded" };
        return { kind: "error", message: msg };
      });
      setLastError(msg);
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (cadenceMs === 0 || timer !== null) return;
      void fetchOnce();
      timer = setInterval(() => {
        void fetchOnce();
      }, cadenceMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = (): void => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        start();
      } else {
        stop();
      }
    };

    if (typeof document === "undefined" || document.visibilityState === "visible") {
      start();
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [cadenceMs, fetchOnce]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const onStopAll = useCallback(async () => {
    if (!window.confirm("Stop all generator and bulk-ingest runs?")) return;
    setStopAllBusy(true);
    try {
      await stopAllRuns();
    } finally {
      setStopAllBusy(false);
    }
  }, []);

  const secondsAgo = lastFetchAt !== null ? Math.max(0, Math.floor((now - lastFetchAt) / 1000)) : 0;
  const showRefreshError = lastError !== null && status.kind === "ready";
  const badgeText =
    cadenceMs === 0 ? `Updated ${humanizeSeconds(secondsAgo)} ago` : cadenceLabel(cadenceMs);

  const bootstrap = status.kind === "ready" ? status.data.bootstrap : null;
  const showBootstrapBar = bootstrap != null
    && bootstrap.phase !== "ready"
    && bootstrap.phase !== "idle";

  return (
    <div className="obs-page">
      <header className="obs-page__header">
        <div className="obs-page__intro">
          <h1>Observability</h1>
          <p className="obs-page__subtitle">
            Live Redis health, ingest workloads, and calculation activity for the active target.
          </p>
        </div>
        <div className="observability__controls">
          <label className="observability__refresh-label" htmlFor="obs-refresh-select">
            Refresh
          </label>
          <select
            id="obs-refresh-select"
            data-testid="obs-refresh-select"
            className="observability__refresh-select"
            value={String(cadenceMs)}
            onChange={(e) => setCadenceMs(Number(e.target.value))}
          >
            {OBS_REFRESH_OPTIONS.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
          {cadenceMs === 0 && (
            <button
              type="button"
              data-testid="obs-manual-refresh"
              className="observability__manual-refresh"
              title="Refresh now"
              aria-label="Refresh now"
              disabled={inFlight}
              onClick={() => {
                void fetchOnce();
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                aria-hidden="true"
                focusable="false"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                <path d="M3 21v-5h5" />
              </svg>
            </button>
          )}
          <span
            data-testid="obs-updated-badge"
            data-pulse-key={pulseKey}
            className={`observability__updated${cadenceMs === 0 ? " observability__updated--off" : ""}`}
          >
            <span key={pulseKey} className="observability__updated-pulse">
              {badgeText}
            </span>
          </span>
          {showRefreshError ? (
            <span
              data-testid="obs-refresh-error"
              className="observability__refresh-error"
              role="status"
            >
              Last refresh failed, retrying…
            </span>
          ) : null}
        </div>
      </header>

      {showBootstrapBar ? (
        <div className="obs-bootstrap-bar" data-testid="obs-bootstrap-bar" data-phase={bootstrap!.phase}>
          <span className="obs-bootstrap-bar__label">Bootstrap</span>
          <span className={`pill pill--${bootstrap!.phase === "failed" ? "err" : "warn"}`}>
            {bootstrap!.phase}
          </span>
          {bootstrap!.target_label ? (
            <span className="obs-bootstrap-bar__target">target <code>{bootstrap!.target_label}</code></span>
          ) : null}
          {bootstrap!.err ? (
            <span className="obs-bootstrap-bar__err">{bootstrap!.err}</span>
          ) : null}
          <Link to="/connections" className="obs-bootstrap-bar__link">Connections</Link>
        </div>
      ) : null}

      <ObservabilityOpsBanner />

      {status.kind === "loading" && (
        <div className="observability__loading" role="status">
          loading observability…
          {lastError ? (
            <span className="observability__loading-hint">
              {" "}
              Redis may be busy with an in-flight calculation — retrying…
            </span>
          ) : null}
        </div>
      )}

      {status.kind === "degraded" && (
        <>
          <div
            className="obs-bootstrap-bar obs-bootstrap-bar--calc"
            data-testid="obs-degraded-banner"
            role="status"
          >
            <span className="obs-bootstrap-bar__label">Redis busy</span>
            <span className="pill pill--warn">calc in flight</span>
            <span>
              Cluster metrics are paused while Redis runs the calculation — workload
              and calc progress cards below still update.
            </span>
          </div>
          <ObservabilityWorkloads
            now={now}
            onStopAll={stopAllBusy ? undefined : () => { void onStopAll(); }}
          />
        </>
      )}

      {status.kind === "error" && (
        <div className="observability__error" role="alert">
          failed to load observability: {status.message}
        </div>
      )}

      {status.kind === "ready" && (
        <ObservabilityReady
          data={status.data}
          pulseKey={pulseKey}
          now={now}
          onStopAll={stopAllBusy ? undefined : () => { void onStopAll(); }}
        />
      )}

      <div className="obs-page__footnote">
        <EnterpriseCallout signal="ObservabilityModule">
          RedisInsight-style observability built into the app — keys, memory,
          ops/sec, and live ingest/calc workload health from the bundled enterprise
          modules. No third-party telemetry stack required.
        </EnterpriseCallout>
      </div>
    </div>
  );
}

interface SnapshotMetricSpec {
  key?: MetricName;
  label: string;
  unit?: string;
  value: number;
  display: string;
  format: (v: number) => string;
  status?: MetricStatus;
  hint: string;
  onClick?: () => void;
  history?: boolean;
  testId?: string;
}

function ObservabilityReady({
  data,
  pulseKey,
  now,
  onStopAll,
}: {
  data: ObservabilityData;
  pulseKey: number;
  now: number;
  onStopAll?: () => void;
}) {
  const [keysModalOpen, setKeysModalOpen] = useState(false);
  const totalKeys = data.keys.dbsize;
  const memHuman = data.memory.used_memory_human ?? "—";
  const memBytes = Number(data.memory.used_memory ?? 0);
  const capBytes = resolveMemoryCapBytes({
    maxmemory_bytes: data.memory.maxmemory_bytes,
    total_system_memory_bytes: data.memory.total_system_memory_bytes,
  });
  const memPct = memoryUsagePct(memBytes, capBytes);
  const memLevel = memoryBarLevel(memPct);
  const opsPerSec = Number(data.memory.instantaneous_ops_per_sec ?? 0);
  const sensCount = data.indexCount;
  const sensRefreshing = data.indexRefreshing;

  if (totalKeys === 0 && sensCount === 0) {
    return (
      <section className="obs-section">
        <PanelCard title="Cluster health">
          <div className="observability__empty" role="status">
            No sensitivities loaded yet. Run a generator or bulk ingest job to populate
            the cluster — metrics will appear here once data is written.
          </div>
        </PanelCard>
      </section>
    );
  }

  const memDisplay = memPct != null
    ? `${memHuman} · ${memPct.toFixed(1)}%`
    : memHuman;

  const specs: SnapshotMetricSpec[] = [
    {
      key: "total_keys",
      label: "Total keys",
      unit: "keys",
      value: totalKeys,
      display: formatNumber(totalKeys),
      format: formatNumber,
      hint: "Click for key sample",
      onClick: () => setKeysModalOpen(true),
      history: true,
    },
    {
      key: "memory_used_bytes",
      label: "Memory used",
      value: memBytes,
      display: memDisplay,
      format: (v) => `${(v / (1024 * 1024)).toFixed(2)} MB`,
      hint: "Click for history",
      history: true,
    },
    {
      key: "ops_per_sec",
      label: "Ops / sec",
      unit: "ops/s",
      value: opsPerSec,
      display: formatNumber(opsPerSec),
      format: formatNumber,
      hint: "Click for history",
      history: true,
    },
    {
      label: "Sensitivities",
      unit: "indexed",
      value: sensCount,
      display: formatNumber(sensCount),
      format: formatNumber,
      status: sensRefreshing ? "pending" : "live",
      hint: "Cached index row estimate",
      history: false,
      testId: "obs-sens-tile",
    },
  ];

  return (
    <>
      <section className="obs-section" aria-labelledby="obs-cluster-heading">
        <PanelCard title="Cluster health">
          <p id="obs-cluster-heading" className="obs-section__lede">
            Snapshot of the active Redis target — refreshed on your cadence above.
          </p>
          <div className="obs-cluster-grid">
            {specs.map((s) => (
              <ClusterTile key={s.label} spec={s} pulseKey={pulseKey} />
            ))}
          </div>
          {memPct != null && capBytes != null ? (
            <div
              className="ingest-memory-bar obs-memory-bar"
              data-testid="obs-memory-bar"
              data-level={memLevel}
              role="meter"
              aria-valuenow={Math.round(memPct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Memory ${Math.round(memPct)}% used`}
            >
              <div className="ingest-memory-bar__track" aria-hidden="true">
                <div
                  className="ingest-memory-bar__fill"
                  style={{ width: `${memPct.toFixed(1)}%` }}
                />
              </div>
              <span className="ingest-memory-bar__caption">
                {memHuman} / {formatBytesCompact(capBytes)}
                {` · ${memPct.toFixed(1)}% of cap`}
              </span>
            </div>
          ) : null}
        </PanelCard>
      </section>

      <KeysSampleModal
        open={keysModalOpen}
        onClose={() => setKeysModalOpen(false)}
        dbsize={totalKeys}
        prefix={data.keys.prefix}
        sample={data.keys.sample}
      />

      <ObservabilityWorkloads now={now} onStopAll={onStopAll} recent={data.recent} />
    </>
  );
}

function ObservabilityWorkloads({
  now,
  onStopAll,
  recent = [],
}: {
  now: number;
  onStopAll?: () => void;
  recent?: RecentCalcRun[];
}) {
  return (
    <>
      <section className="obs-section" aria-labelledby="obs-workloads-heading">
        <h2 id="obs-workloads-heading" className="obs-section__heading">Active workloads</h2>
        <div className="obs-dual-grid">
          <div className="obs-dual-grid__item">
            <ActiveJobsCard onRequestStopAll={onStopAll} />
          </div>
          <div className="obs-dual-grid__item">
            <IngestSnapshotCard />
          </div>
        </div>
      </section>

      <section className="obs-section" aria-labelledby="obs-calc-heading">
        <h2 id="obs-calc-heading" className="obs-section__heading">Calculations</h2>
        <div className="obs-dual-grid">
          <div className="obs-dual-grid__item">
            <LastCalcCard items={recent} now={now} />
          </div>
          <div className="obs-dual-grid__item">
            <CalcHealthStrip />
          </div>
        </div>
      </section>

      <section className="obs-section" aria-labelledby="obs-history-heading">
        <h2 id="obs-history-heading" className="obs-section__heading">Ingest history</h2>
        <IngestRunsCompactCard />
      </section>
    </>
  );
}

function ClusterTile({ spec, pulseKey }: { spec: SnapshotMetricSpec; pulseKey: number }) {
  const [open, setOpen] = useState(false);
  const [modalWindowMs, setModalWindowMs] = useState<number>(RETENTION_MS);
  const currentValue = Number.isFinite(spec.value) ? spec.value : null;
  const useHistoryModal = spec.history !== false && spec.onClick == null;
  const sparkline = useMetricHistory({
    metric: spec.key ?? "total_keys",
    currentValue,
    pulseKey,
    enabled: spec.history !== false && spec.key != null,
  });
  const modalHistory = useMetricHistory({
    metric: spec.key ?? "total_keys",
    currentValue,
    pulseKey,
    enabled: open && spec.key != null,
    windowMs: modalWindowMs,
  });
  const sparkPoints = spec.history === false
    ? (currentValue != null ? Array(8).fill(currentValue) : [])
    : sparkline.points.map((p) => p.v);
  const handleClose = (): void => {
    setOpen(false);
    setModalWindowMs(RETENTION_MS);
  };
  const handleClick = (): void => {
    if (spec.onClick) {
      spec.onClick();
      return;
    }
    if (useHistoryModal) setOpen(true);
  };
  const interactive = spec.onClick != null || useHistoryModal;

  return (
    <div className="obs-cluster-tile" data-testid={spec.testId}>
      <MetricTile
        label={spec.label}
        value={spec.display}
        unit={spec.unit}
        status={spec.status ?? "live"}
        history={{
          points: sparkPoints,
          ariaLabel: `${spec.label} sparkline`,
        }}
        onClick={interactive ? handleClick : undefined}
      />
      <span className="obs-cluster-tile__hint">{spec.hint}</span>
      {useHistoryModal ? (
        <MetricHistoryModal
          open={open}
          onClose={handleClose}
          title={spec.label}
          unit={spec.unit}
          formatValue={spec.format}
          points={modalHistory.points}
          source={modalHistory.source}
          reason={modalHistory.reason}
          windowMs={modalWindowMs}
          onWindowChange={setModalWindowMs}
          targetLabel={modalHistory.target_label}
        />
      ) : null}
    </div>
  );
}
