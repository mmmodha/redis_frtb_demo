import { useCallback, useEffect, useRef, useState } from "react";
import { PanelCard } from "../components/PanelCard";
import { MetricTile } from "../components/MetricTile";
import { MetricHistoryModal } from "../components/MetricHistoryModal";
import { TimingStrip } from "../components/TimingStrip";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { ShardMetricsStrip } from "../components/ShardMetricsStrip";
import { LastCalcCard } from "../components/LastCalcCard";
import {
  getObservabilityKeys,
  getObservabilityMemory,
  getObservabilityShards,
  getRecentCalcRuns,
  type ObservabilityKeysResponse,
  type ObservabilityMemoryResponse,
  type ObservabilityShardsResponse,
  type RecentCalcRun,
} from "../lib/api";
import {
  OBS_REFRESH_OPTIONS,
  useObservabilityRefresh,
} from "../hooks/useObservabilityRefresh";
import { useMetricHistory, RETENTION_MS, type MetricName } from "../hooks/useMetricHistory";

interface ObservabilityData {
  keys: ObservabilityKeysResponse;
  memory: ObservabilityMemoryResponse;
  shards: ObservabilityShardsResponse;
  recent: RecentCalcRun[];
}

type Status =
  | { kind: "loading" }
  | { kind: "ready"; data: ObservabilityData }
  | { kind: "error"; message: string };

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function cadenceLabel(cadenceMs: number): string {
  return cadenceMs === 0 ? "Off" : `${cadenceMs / 1000}s`;
}

// Wave 6.00 — compact humanized time-since: Ns (<60s), Nm (<60m), Nh (<24h),
// Nd (≥24h). Exported for unit tests covering each unit boundary.
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
  const inFlightRef = useRef<boolean>(false);

  // Hoisted fetch so the polling loop and the manual refresh button can share
  // a single in-flight guard. inFlightRef avoids a stale-closure race where
  // two near-simultaneous callers both see inFlight=false.
  const fetchOnce = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const [keys, memory, shards, recent] = await Promise.all([
        getObservabilityKeys("sens:"),
        getObservabilityMemory(),
        getObservabilityShards(),
        getRecentCalcRuns(5),
      ]);
      setStatus({ kind: "ready", data: { keys, memory, shards, recent: recent.items } });
      setLastError(null);
      setLastFetchAt(Date.now());
      setNow(Date.now());
      setPulseKey((k) => k + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only blow away the page on first-load failure. After we have data,
      // keep showing it and surface the failure as an inline pill.
      setStatus((prev) => (prev.kind === "loading" ? { kind: "error", message: msg } : prev));
      setLastError(msg);
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, []);

  // Cadence-driven polling loop. Pauses when the tab is hidden and resumes
  // (with an immediate fetch) on visibilitychange. Cleanup clears the
  // interval on unmount or cadence change.
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

  // Lightweight 1s ticker so the "Updated Ns ago" badge counts up between
  // fetches; independent of the cadence loop so it stays smooth even when
  // cadence is 5s/10s.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsAgo = lastFetchAt !== null ? Math.max(0, Math.floor((now - lastFetchAt) / 1000)) : 0;
  const showRefreshError = lastError !== null && status.kind === "ready";
  // Wave 6.00 — when auto-refresh is on, the cadence itself tells you how
  // fresh the data is, so the "Updated Ns ago" prefix is redundant noise.
  // When cadence is Off, the humanized timestamp is the most useful thing.
  const badgeText =
    cadenceMs === 0 ? `Updated ${humanizeSeconds(secondsAgo)} ago` : cadenceLabel(cadenceMs);

  return (
    <>
      <header className="observability__header">
        <h1>Observability</h1>
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
      <EnterpriseCallout signal="ObservabilityModule">
        RedisInsight-style observability built into the app — ops/sec, memory,
        per-shard breakdown — all from the bundled enterprise modules. No third
        party telemetry stack required.
      </EnterpriseCallout>

      {status.kind === "loading" && (
        <div className="observability__loading" role="status">
          loading observability…
        </div>
      )}

      {status.kind === "error" && (
        <div className="observability__error" role="alert">
          failed to load observability: {status.message}
        </div>
      )}

      {status.kind === "ready" && (
        <ObservabilityReady data={status.data} pulseKey={pulseKey} now={now} />
      )}
    </>
  );
}

interface SnapshotMetricSpec {
  key: MetricName;
  label: string;
  unit?: string;
  value: number;
  display: string;
  format: (v: number) => string;
}

function ObservabilityReady({
  data,
  pulseKey,
  now,
}: {
  data: ObservabilityData;
  pulseKey: number;
  now: number;
}) {
  const totalKeys = data.keys.dbsize;
  const memHuman = data.memory.used_memory_human ?? "—";
  const memBytes = Number(data.memory.used_memory ?? 0);
  const shards = data.shards;

  if (totalKeys === 0 && shards.length === 0) {
    return (
      <PanelCard title="Cluster state">
        <div className="observability__empty" role="status">
          no sensitivities loaded yet — run a generator job to populate the
          cluster, then this tab will light up with live metrics.
        </div>
      </PanelCard>
    );
  }

  const totalOps = shards.reduce((acc, s) => acc + (s.opsPerSec ?? 0), 0);
  const specs: SnapshotMetricSpec[] = [
    { key: "total_keys", label: "Total keys", unit: "keys", value: totalKeys, display: formatNumber(totalKeys), format: formatNumber },
    { key: "memory_used_bytes", label: "Memory used", value: memBytes, display: memHuman, format: (v) => `${(v / (1024 * 1024)).toFixed(2)} MB` },
    { key: "shard_count", label: "Shards", unit: "primaries", value: shards.length, display: String(shards.length), format: (v) => String(Math.round(v)) },
    { key: "ops_per_sec", label: "Ops / sec", unit: "ops/s", value: totalOps, display: formatNumber(totalOps), format: formatNumber },
  ];

  return (
    <>
      <PanelCard title="Cluster snapshot">
        <div className="metric-grid">
          {specs.map((s) => (
            <SnapshotTile key={s.key} spec={s} pulseKey={pulseKey} />
          ))}
        </div>
      </PanelCard>
      <LastCalcCard items={data.recent} now={now} />
      <PanelCard title="Per-shard ops/sec">
        <TimingStrip
          shards={shards.map((s) => ({
            id: s.shardId,
            label: s.shardId,
            ms: s.opsPerSec ?? 0,
          }))}
          unit="ops/s"
        />
      </PanelCard>
      <PanelCard title="Live shard metrics">
        <ShardMetricsStrip shards={shards} />
      </PanelCard>
    </>
  );
}

function SnapshotTile({ spec, pulseKey }: { spec: SnapshotMetricSpec; pulseKey: number }) {
  const [open, setOpen] = useState(false);
  // Wave 5.61 — Option B: the inline sparkline keeps its own 5h history,
  // while the popout modal owns a separate windowMs that the user can zoom
  // independently. The modal-side hook is enabled only while open.
  const [modalWindowMs, setModalWindowMs] = useState<number>(RETENTION_MS);
  const currentValue = Number.isFinite(spec.value) ? spec.value : null;
  const sparkline = useMetricHistory({
    metric: spec.key,
    currentValue,
    pulseKey,
  });
  const modalHistory = useMetricHistory({
    metric: spec.key,
    currentValue,
    pulseKey,
    enabled: open,
    windowMs: modalWindowMs,
  });
  const sparkPoints = sparkline.points.map((p) => p.v);
  const handleClose = (): void => {
    setOpen(false);
    setModalWindowMs(RETENTION_MS);
  };
  return (
    <>
      <MetricTile
        label={spec.label}
        value={spec.display}
        unit={spec.unit}
        status="live"
        history={{ points: sparkPoints, ariaLabel: `${spec.label} history sparkline` }}
        onClick={() => setOpen(true)}
      />
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
    </>
  );
}
