// Wave 7.0.4.B — live per-shard panel. Polls GET /observability/per-shard at
// ~1Hz, surfaces memory / key_count / write_ops_per_sec / index_lag per
// master shard, draws a memory bar relative to the cluster max, a 60-sample
// write-rps sparkline per shard, and visually highlights any shard whose
// selected metric deviates from the cluster mean by more than 10%.
//
// Out of scope (per task spec): alerting. The deviation flag is render-only.
import { useEffect, useMemo, useRef, useState } from "react";
import { PanelCard } from "./PanelCard";
import { Sparkline } from "./Sparkline";
import { getObservabilityPerShard, type PerShardRow } from "../lib/api";
import {
  computeShardDeviationFlags,
  type DeviationMetric,
  DEFAULT_DEVIATION_THRESHOLD,
} from "../lib/per-shard-deviation";

const POLL_INTERVAL_MS = 1000;
const SPARKLINE_WINDOW = 60;

type SortKey = "shard_id" | DeviationMetric;
type Status = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

const NUMBER_FMT = new Intl.NumberFormat("en-US");

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

function formatNullableNumber(n: number | null): string {
  return n === null ? "—" : NUMBER_FMT.format(n);
}

function compareRows(a: PerShardRow, b: PerShardRow, key: SortKey, asc: boolean): number {
  const dir = asc ? 1 : -1;
  if (key === "shard_id") return a.shard_id.localeCompare(b.shard_id) * dir;
  const av = a[key] ?? -Infinity;
  const bv = b[key] ?? -Infinity;
  if (av === bv) return a.shard_id.localeCompare(b.shard_id);
  return (Number(av) - Number(bv)) * dir;
}

export interface PerShardPanelProps {
  pollIntervalMs?: number;
  initialRows?: PerShardRow[];
  deviationMetric?: DeviationMetric;
  deviationThreshold?: number;
}

export function PerShardPanel({
  pollIntervalMs = POLL_INTERVAL_MS,
  initialRows,
  deviationMetric: deviationMetricProp,
  deviationThreshold = DEFAULT_DEVIATION_THRESHOLD,
}: PerShardPanelProps = {}) {
  const [rows, setRows] = useState<PerShardRow[]>(initialRows ?? []);
  const [status, setStatus] = useState<Status>(initialRows ? { kind: "ready" } : { kind: "loading" });
  const [sortKey, setSortKey] = useState<SortKey>("shard_id");
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [deviationMetric, setDeviationMetric] = useState<DeviationMetric>(
    deviationMetricProp ?? "write_ops_per_sec",
  );
  // Per-shard ring buffer of recent write_ops_per_sec values for the sparkline.
  const writeHistoryRef = useRef<Map<string, number[]>>(new Map());
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async (): Promise<void> => {
      try {
        const data = await getObservabilityPerShard();
        if (cancelled) return;
        setRows(data);
        setStatus({ kind: "ready" });
        const hist = writeHistoryRef.current;
        for (const r of data) {
          const v = r.write_ops_per_sec === null ? 0 : Number(r.write_ops_per_sec);
          const safe = Number.isFinite(v) ? v : 0;
          const buf = hist.get(r.shard_id) ?? [];
          buf.push(safe);
          if (buf.length > SPARKLINE_WINDOW) buf.splice(0, buf.length - SPARKLINE_WINDOW);
          hist.set(r.shard_id, buf);
        }
        setHistoryVersion((n) => n + 1);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus((prev) => (prev.kind === "ready" ? prev : { kind: "error", message: msg }));
      }
    };
    void fetchOnce();
    const id = setInterval(() => { void fetchOnce(); }, pollIntervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [pollIntervalMs]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => compareRows(a, b, sortKey, sortAsc));
  }, [rows, sortKey, sortAsc]);

  const deviationFlags = useMemo(
    () => computeShardDeviationFlags(rows, deviationMetric, deviationThreshold),
    [rows, deviationMetric, deviationThreshold],
  );

  const maxMemory = useMemo(
    () => rows.reduce((m, r) => (r.memory_used > m ? r.memory_used : m), 0),
    [rows],
  );

  const onHeaderClick = (key: SortKey): void => {
    if (key === sortKey) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const degraded = rows.length > 0 && rows.every((r) => r.degraded);

  if (status.kind === "loading") {
    return (
      <PanelCard title="Per-shard live metrics">
        <div className="per-shard-panel__loading" role="status">loading per-shard metrics…</div>
      </PanelCard>
    );
  }
  if (status.kind === "error") {
    return (
      <PanelCard title="Per-shard live metrics">
        <div className="per-shard-panel__error" role="alert">
          failed to load per-shard metrics: {status.message}
        </div>
      </PanelCard>
    );
  }

  return (
    <PanelCard title="Per-shard live metrics">
      <PerShardPanelBody
        rows={sortedRows}
        sortKey={sortKey}
        sortAsc={sortAsc}
        onSort={onHeaderClick}
        deviationFlags={deviationFlags}
        deviationMetric={deviationMetric}
        onDeviationMetricChange={setDeviationMetric}
        maxMemory={maxMemory}
        writeHistory={writeHistoryRef.current}
        historyVersion={historyVersion}
        degraded={degraded}
      />
    </PanelCard>
  );
}

interface PerShardPanelBodyProps {
  rows: readonly PerShardRow[];
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (k: SortKey) => void;
  deviationFlags: ReadonlySet<string>;
  deviationMetric: DeviationMetric;
  onDeviationMetricChange: (m: DeviationMetric) => void;
  maxMemory: number;
  writeHistory: Map<string, number[]>;
  historyVersion: number;
  degraded: boolean;
}

const DEVIATION_OPTIONS: ReadonlyArray<{ value: DeviationMetric; label: string }> = [
  { value: "memory_used", label: "Memory" },
  { value: "key_count", label: "Keys" },
  { value: "write_ops_per_sec", label: "Write rps" },
  { value: "index_lag", label: "Index lag" },
];

function PerShardPanelBody(props: PerShardPanelBodyProps) {
  const { rows, sortKey, sortAsc, onSort, deviationFlags, deviationMetric, onDeviationMetricChange, maxMemory, writeHistory, historyVersion, degraded } = props;
  if (rows.length === 0) {
    return <div className="per-shard-panel__empty" role="status">no shards reported</div>;
  }
  return (
    <div className="per-shard-panel" data-testid="per-shard-panel" data-history-version={historyVersion}>
      <div className="per-shard-panel__controls">
        <label className="per-shard-panel__deviation-label" htmlFor="per-shard-deviation-metric">
          Highlight deviation on
        </label>
        <select
          id="per-shard-deviation-metric"
          data-testid="per-shard-deviation-metric"
          value={deviationMetric}
          onChange={(e) => onDeviationMetricChange(e.target.value as DeviationMetric)}
        >
          {DEVIATION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {degraded ? (
          <span className="per-shard-panel__degraded" role="status" data-testid="per-shard-degraded">
            no fresh rladmin snapshot — showing aggregated fallback
          </span>
        ) : null}
      </div>
      <table className="per-shard-panel__table">
        <thead>
          <tr>
            <ThCell label="Shard" sortKey="shard_id" current={sortKey} asc={sortAsc} onSort={onSort} />
            <ThCell label="Memory" sortKey="memory_used" current={sortKey} asc={sortAsc} onSort={onSort} />
            <ThCell label="Keys" sortKey="key_count" current={sortKey} asc={sortAsc} onSort={onSort} />
            <ThCell label="Write rps" sortKey="write_ops_per_sec" current={sortKey} asc={sortAsc} onSort={onSort} />
            <ThCell label="Index lag" sortKey="index_lag" current={sortKey} asc={sortAsc} onSort={onSort} />
            <th scope="col">Write rps (60s)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const flagged = deviationFlags.has(r.shard_id);
            const memPct = maxMemory > 0 ? Math.min(100, (r.memory_used / maxMemory) * 100) : 0;
            const hist = writeHistory.get(r.shard_id) ?? [];
            return (
              <tr
                key={r.shard_id}
                data-testid="per-shard-row"
                data-shard-id={r.shard_id}
                data-deviation={flagged ? "1" : "0"}
                className={flagged ? "per-shard-panel__row per-shard-panel__row--deviation" : "per-shard-panel__row"}
              >
                <td>
                  <span className="per-shard-panel__shard-id">{r.shard_id}</span>
                  {r.degraded ? <span className="per-shard-panel__pill">degraded</span> : null}
                </td>
                <td>
                  <div className="per-shard-panel__memory">
                    <div className="per-shard-panel__memory-bar-track" aria-hidden="true">
                      <div
                        className="per-shard-panel__memory-bar-fill"
                        data-testid="per-shard-memory-bar"
                        style={{ width: `${memPct.toFixed(2)}%` }}
                      />
                    </div>
                    <span className="per-shard-panel__memory-label">{formatBytes(r.memory_used)}</span>
                  </div>
                </td>
                <td className="per-shard-panel__numeric">{formatNullableNumber(r.key_count)}</td>
                <td className="per-shard-panel__numeric">{formatNullableNumber(r.write_ops_per_sec)}</td>
                <td className="per-shard-panel__numeric">{formatNullableNumber(r.index_lag)}</td>
                <td>
                  {hist.length > 0 ? (
                    <Sparkline
                      points={hist}
                      width={120}
                      height={24}
                      filled
                      dots="last"
                      ariaLabel={`write rps history for ${r.shard_id}`}
                    />
                  ) : <span className="per-shard-panel__sparkline-empty">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ThCell({ label, sortKey, current, asc, onSort }: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  asc: boolean;
  onSort: (k: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <th scope="col" aria-sort={active ? (asc ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="per-shard-panel__sort-button"
        data-testid={`per-shard-sort-${sortKey}`}
        data-sort-active={active ? "1" : "0"}
        onClick={() => onSort(sortKey)}
      >
        {label}{active ? (asc ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}
