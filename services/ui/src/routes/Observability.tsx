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

export function Observability() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [keys, memory, shards] = await Promise.all([
          getObservabilityKeys("sens:"),
          getObservabilityMemory(),
          getObservabilityShards(),
        ]);
        if (!cancelled) setStatus({ kind: "ready", data: { keys, memory, shards } });
      } catch (err) {
        if (!cancelled) {
          setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <h1>Observability</h1>
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
        <ShardMetricsStrip />
      </PanelCard>
    </>
  );
}
