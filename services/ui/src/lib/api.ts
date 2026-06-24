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
  // Default to "/api" so the browser hits the UI's own origin; the UI server
  // reverse-proxies "/api/*" → http://localhost:<API_PORT>/*. This lets a
  // single-VM deploy expose only port 3000.
  return fromEnv ?? "/api";
}

async function getJson<T>(
  path: string,
  opts?: { retries?: number; retryDelayMs?: number },
): Promise<T> {
  const retries = opts?.retries ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? 1_500;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${apiBase()}${path}`);
    if (res.ok) {
      return (await res.json()) as T;
    }
    if (res.status === 503 && attempt < retries) {
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
      continue;
    }
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = `: ${body.error}`;
    } catch {
      // ignore non-JSON bodies
    }
    throw new Error(`api ${path} ${res.status}${detail}`);
  }
  throw new Error(`api ${path} failed after retries`);
}

const OBS_FETCH_OPTS = { retries: 4, retryDelayMs: 2_000 } as const;

export function getObservabilityKeys(prefix = "sens:"): Promise<ObservabilityKeysResponse> {
  return getJson<ObservabilityKeysResponse>(`/observability/keys?prefix=${prefix}`, OBS_FETCH_OPTS);
}

export function getObservabilityMemory(): Promise<ObservabilityMemoryResponse> {
  return getJson<ObservabilityMemoryResponse>(`/observability/memory`, OBS_FETCH_OPTS);
}

export function getObservabilityShards(): Promise<ObservabilityShardsResponse> {
  return getJson<ObservabilityShardsResponse>(`/observability/shards`, OBS_FETCH_OPTS);
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

// Wave 6.01 — process-local ring buffer of recent /calc/sbm and
// /calc/sbm/total runs surfaced via GET /calc/recent. Discriminated union by
// `kind` so the Observability "Last Calculation" card can render distinct
// metric tile sets without sniffing payload shape.
export interface RecentCalcRunCommon {
  id: string;
  ts: string;
  charge: number;
  total_ms: number;
  cache: "hit" | "miss";
  engine: string;
}
export interface RecentCalcRunPerClass extends RecentCalcRunCommon {
  kind: "per_class";
  risk_class: string;
  leg: string;
  scenario?: string;
  fanout_ms: number;
  cells_evaluated: number;
}
export interface RecentCalcRunTotal extends RecentCalcRunCommon {
  kind: "total";
  cumulative_ms: number;
  parallelism_factor: number;
  redis_ops_count: number;
  ops_skipped: number;
  cells_empty: number;
  cache_hits: number;
}
export type RecentCalcRun = RecentCalcRunPerClass | RecentCalcRunTotal;
export interface RecentCalcRunsResponse { items: RecentCalcRun[] }

export function getRecentCalcRuns(limit = 5): Promise<RecentCalcRunsResponse> {
  return getJson<RecentCalcRunsResponse>(`/calc/recent?limit=${limit}`);
}

// Wave 7.0.4.B — per-shard observability row as returned by GET
// /observability/per-shard. Shape mirrors services/api/src/routes/observability
// .ts `PerShardRow` (Wave 7.0.4.A). `degraded:true` is set on the single
// aggregated fallback row the api emits when no fresh rladmin snapshot is
// available — the UI panel surfaces this state distinctly from real shards.
export interface PerShardRow {
  shard_id: string;
  role: string;
  memory_used: number;
  key_count: number | null;
  write_ops_per_sec: number | null;
  index_lag: number | null;
  last_observed_at: string | null;
  snapshot_age_seconds: number | null;
  degraded?: true;
}

export type PerShardResponse = PerShardRow[];

export function getObservabilityPerShard(): Promise<PerShardResponse> {
  return getJson<PerShardResponse>(`/observability/per-shard`);
}
