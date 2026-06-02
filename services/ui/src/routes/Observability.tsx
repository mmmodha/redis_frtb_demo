import { useEffect, useState } from "react";
import { PanelCard } from "../components/PanelCard";
import { MetricTile } from "../components/MetricTile";
import { TimingStrip } from "../components/TimingStrip";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { ShardMetricsStrip } from "../components/ShardMetricsStrip";
import {
  getObservabilityKeys,
  getObservabilityMemory,
  getObservabilityShards,
  type ObservabilityKeysResponse,
  type ObservabilityMemoryResponse,
  type ObservabilityShardsResponse,
} from "../lib/api";
import {
  OBS_REFRESH_OPTIONS,
  useObservabilityRefresh,
} from "../hooks/useObservabilityRefresh";

interface ObservabilityData {
  keys: ObservabilityKeysResponse;
  memory: ObservabilityMemoryResponse;
  shards: ObservabilityShardsResponse;
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

export function Observability() {
  const { cadenceMs, setCadenceMs } = useObservabilityRefresh();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [pulseKey, setPulseKey] = useState<number>(0);

  // Cadence-driven polling loop. Pauses when the tab is hidden and resumes
  // (with an immediate fetch) on visibilitychange. Cleanup clears the
  // interval on unmount or cadence change.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchOnce = async (): Promise<void> => {
      try {
        const [keys, memory, shards] = await Promise.all([
          getObservabilityKeys("sens:"),
          getObservabilityMemory(),
          getObservabilityShards(),
        ]);
        if (cancelled) return;
        setStatus({ kind: "ready", data: { keys, memory, shards } });
        setLastError(null);
        setLastFetchAt(Date.now());
        setNow(Date.now());
        setPulseKey((k) => k + 1);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Only blow away the page on first-load failure. After we have data,
        // keep showing it and surface the failure as an inline pill.
        setStatus((prev) => (prev.kind === "loading" ? { kind: "error", message: msg } : prev));
        setLastError(msg);
      }
    };

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
      cancelled = true;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [cadenceMs]);

  // Lightweight 1s ticker so the "Updated Ns ago" badge counts up between
  // fetches; independent of the cadence loop so it stays smooth even when
  // cadence is 5s/10s.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsAgo = lastFetchAt !== null ? Math.max(0, Math.floor((now - lastFetchAt) / 1000)) : 0;
  const showRefreshError = lastError !== null && status.kind === "ready";
  const badgeText = cadenceMs === 0 ? "Off" : `Updated ${secondsAgo}s ago · ${cadenceLabel(cadenceMs)}`;

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
          <span
            data-testid="obs-updated-badge"
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

      {status.kind === "ready" && <ObservabilityReady data={status.data} />}
    </>
  );
}

function ObservabilityReady({ data }: { data: ObservabilityData }) {
  const totalKeys = data.keys.dbsize;
  const memHuman = data.memory.used_memory_human ?? "—";
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

  return (
    <>
      <PanelCard title="Cluster snapshot">
        <div className="metric-grid">
          <MetricTile label="Total keys" value={formatNumber(totalKeys)} unit="keys" status="live" />
          <MetricTile label="Memory used" value={memHuman} status="live" />
          <MetricTile label="Shards" value={shards.length} unit="primaries" status="live" />
          <MetricTile label="Ops / sec" value={formatNumber(totalOps)} unit="ops/s" status="live" />
        </div>
      </PanelCard>
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
