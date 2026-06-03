// Tiny fetch wrapper for the Wave 2 api service endpoints used by the
// Observability tab. Other panels' tasks add their own typed clients
// alongside this file (e.g. ./calc.ts).

export interface ObservabilityKeysResponse {
  prefix: string;
  dbsize: number;
  sample: string[];
  sample_size: number;
  ms: number;
}

export interface ObservabilityMemoryResponse {
  used_memory: number;
  used_memory_human: string;
  used_memory_peak?: number;
  // Wave 5.20a — cluster capacity surfaced for the Ingest panel sanity check.
  // `maxmemory_bytes` is 0 when Redis has no `maxmemory` configured.
  maxmemory_bytes?: number;
  total_system_memory_bytes?: number;
  dbsize?: number;
  ms: number;
  [k: string]: number | string | undefined;
}

// Per-shard observability record as returned by GET /observability/shards.
// Shape mirrors services/api/src/routes/observability.ts `Shard`.
export interface ObservabilityShard {
  shardId: string;
  role: string;
  opsPerSec: number;
  slotCount: number;
  usedMemoryBytes: number;
  netInBytes: number;
  netOutBytes: number;
}

export type ObservabilityShardsResponse = ObservabilityShard[];

export function apiBase(): string {
  const fromEnv = (import.meta as ImportMeta & { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE;
  return fromEnv ?? "http://localhost:8080";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) {
    throw new Error(`api ${path} ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getObservabilityKeys(prefix = "sens:"): Promise<ObservabilityKeysResponse> {
  return getJson<ObservabilityKeysResponse>(`/observability/keys?prefix=${prefix}`);
}

export function getObservabilityMemory(): Promise<ObservabilityMemoryResponse> {
  return getJson<ObservabilityMemoryResponse>(`/observability/memory`);
}

export function getObservabilityShards(): Promise<ObservabilityShardsResponse> {
  return getJson<ObservabilityShardsResponse>(`/observability/shards`);
}

// Wave 5.57 — historical samples for the Cluster snapshot sparkline / popout
// modal. `source` is "redis-timeseries" when the active target has the TS
// module loaded; "unavailable" triggers the UI's client-side ring-buffer
// fallback.
export interface ObservabilityHistoryPoint { t: number; v: number }
export interface ObservabilityHistoryResponse {
  source: "redis-timeseries" | "unavailable";
  metric: string;
  windowMs: number;
  points: ObservabilityHistoryPoint[];
  reason: null | "module-not-loaded" | "no-data-yet";
  target_label: string;
}

export function getObservabilityHistory(
  metric: string,
  windowMs: number,
): Promise<ObservabilityHistoryResponse> {
  return getJson<ObservabilityHistoryResponse>(
    `/observability/history?metric=${encodeURIComponent(metric)}&windowMs=${windowMs}`,
  );
}
