// Wave 7.0.9 — live bulk-loader replica discovery via /load/status instance_id.
// No dependency on BULK_LOADER_REPLICAS env — scales with `docker compose
// --scale bulk-loader=N` dynamically.

export interface BulkLoadStatusSnapshot {
  instance_id?: string;
  pool_size?: number;
  connected?: number;
  dispatcher?: { in_flight?: number; high_water?: number } | null;
  throttled?: boolean;
  headroom_pct?: number | null;
  recent_429_count?: number;
  body_drain_errors?: number;
  bound_target?: { host: string; port: number; label: string } | null;
  target_stale?: boolean;
  target_watcher?: "enabled" | "disabled" | null;
  workers?: Array<{
    flushed?: number | null;
    queued?: number | null;
    errors?: number | null;
    [key: string]: unknown;
  }>;
}

export interface BulkLoaderTopology {
  /** Distinct bulk-loader processes seen via DNS round-robin probes. */
  replicas: number;
  pool_size_per_replica: number;
  instance_ids: string[];
  /** false when no /load/status probe succeeded */
  live: boolean;
  bound_target: { host: string; port: number; label: string } | null;
  target_stale: boolean | null;
  target_watcher: "enabled" | "disabled" | null;
}

export const MAX_BULK_LOADER_REPLICAS = 16;
/** Parallel probes — enough to hit up to MAX replicas via Compose DNS RR. */
export const DEFAULT_TOPOLOGY_PROBE_COUNT = MAX_BULK_LOADER_REPLICAS * 3;

export function bulkLoaderBaseUrl(): string {
  return (
    process.env.BULK_LOADER_URL
    ?? `http://localhost:${process.env.BULK_LOADER_PORT ?? 8086}`
  ).replace(/\/+$/, "");
}

export function createBulkLoaderStatusFetch(opts?: {
  base?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): () => Promise<BulkLoadStatusSnapshot> {
  const base = opts?.base ?? bulkLoaderBaseUrl();
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? 1_500;
  return async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetchImpl(`${base}/load/status`, {
        method: "GET",
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`bulk-loader /load/status ${res.status}`);
      return (await res.json()) as BulkLoadStatusSnapshot;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function sumFlushed(status: BulkLoadStatusSnapshot): number {
  if (!status.workers?.length) return 0;
  return status.workers.reduce(
    (acc, w) => acc + (typeof w.flushed === "number" ? w.flushed : 0),
    0,
  );
}

/** Sum live pending rows across bulk-loader replicas (dispatcher in_flight). */
export function sumInFlight(status: BulkLoadStatusSnapshot): number {
  return typeof status.dispatcher?.in_flight === "number" ? status.dispatcher.in_flight : 0;
}

/**
 * Merge /load/status snapshots from distinct bulk-loader replicas into one
 * operator-facing view. `workers[].queued` is lifetime-enqueued per worker —
 * never summed here; use dispatcher.in_flight for pending depth.
 */
export function aggregateBulkLoadStatuses(
  snaps: Iterable<BulkLoadStatusSnapshot>,
): BulkLoadStatusSnapshot {
  const list = [...snaps];
  if (list.length === 0) return { workers: [] };

  let inFlight = 0;
  let highWater = 0;
  let flushed = 0;
  let connected = 0;
  let poolSize = 0;
  let throttled = false;
  let recent429 = 0;
  let bodyDrainErrors = 0;
  let headroomPct: number | null = null;

  for (const snap of list) {
    inFlight += sumInFlight(snap);
    if (typeof snap.dispatcher?.high_water === "number") {
      highWater += snap.dispatcher.high_water;
    }
    flushed += sumFlushed(snap);
    if (typeof snap.connected === "number") connected += snap.connected;
    if (typeof snap.pool_size === "number" && snap.pool_size > poolSize) {
      poolSize = snap.pool_size;
    }
    if (snap.throttled) throttled = true;
    recent429 = Math.max(recent429, snap.recent_429_count ?? 0);
    bodyDrainErrors += snap.body_drain_errors ?? 0;
    if (typeof snap.headroom_pct === "number") {
      headroomPct = headroomPct == null
        ? snap.headroom_pct
        : Math.min(headroomPct, snap.headroom_pct);
    }
  }

  const first = list[0]!;
  return {
    instance_id: list.length === 1 ? first.instance_id : `aggregated:${list.length}`,
    pool_size: poolSize || first.pool_size,
    connected: connected || first.connected,
    dispatcher: { in_flight: inFlight, high_water: highWater },
    throttled,
    headroom_pct: headroomPct,
    recent_429_count: recent429,
    body_drain_errors: bodyDrainErrors,
    bound_target: first.bound_target ?? null,
    target_stale: first.target_stale,
    target_watcher: first.target_watcher,
    workers: [{ flushed }],
  };
}

export async function fetchAggregatedBulkLoadStatus(
  fetchOne: () => Promise<BulkLoadStatusSnapshot>,
  replicaCount?: number,
): Promise<BulkLoadStatusSnapshot> {
  const maxProbes = replicaCount != null && replicaCount > 0
    ? Math.max(replicaCount * 3, replicaCount)
    : DEFAULT_TOPOLOGY_PROBE_COUNT;
  const instances = await probeBulkLoaderInstances(fetchOne, { maxProbes });
  return aggregateBulkLoadStatuses(instances.values());
}

function legacySnapshotFingerprint(snap: BulkLoadStatusSnapshot): string {
  return `legacy:${snap.pool_size ?? 0}:${sumFlushed(snap)}`;
}

function snapshotInstanceKey(snap: BulkLoadStatusSnapshot): string {
  if (typeof snap.instance_id === "string" && snap.instance_id.length > 0) {
    return snap.instance_id;
  }
  return legacySnapshotFingerprint(snap);
}

function poolSizeFromInstances(instances: Map<string, BulkLoadStatusSnapshot>): number {
  for (const snap of instances.values()) {
    if (typeof snap.pool_size === "number" && snap.pool_size > 0) return snap.pool_size;
  }
  const poolEnv = Number(process.env.BULK_LOADER_POOL_SIZE);
  if (Number.isFinite(poolEnv) && poolEnv > 0) return poolEnv;
  return 32;
}

/**
 * Parallel /load/status probes via Docker DNS round-robin. Returns one snapshot
 * per distinct bulk-loader process (keyed by instance_id).
 */
export async function probeBulkLoaderInstances(
  fetchOne: () => Promise<BulkLoadStatusSnapshot>,
  opts?: { maxProbes?: number },
): Promise<Map<string, BulkLoadStatusSnapshot>> {
  const maxProbes = opts?.maxProbes ?? DEFAULT_TOPOLOGY_PROBE_COUNT;
  const snaps = await Promise.all(
    Array.from({ length: maxProbes }, () => fetchOne().catch(() => null)),
  );
  const byId = new Map<string, BulkLoadStatusSnapshot>();
  for (const snap of snaps) {
    if (!snap) continue;
    const key = snapshotInstanceKey(snap);
    if (!byId.has(key)) byId.set(key, snap);
  }
  return byId;
}

export async function discoverBulkLoaderTopology(
  fetchOne?: () => Promise<BulkLoadStatusSnapshot>,
  opts?: { maxProbes?: number },
): Promise<BulkLoaderTopology> {
  const fetch = fetchOne ?? createBulkLoaderStatusFetch();
  const instances = await probeBulkLoaderInstances(fetch, opts);
  const empty: BulkLoaderTopology = {
    replicas: 1,
    pool_size_per_replica: poolSizeFromInstances(instances),
    instance_ids: [],
    live: false,
    bound_target: null,
    target_stale: null,
    target_watcher: null,
  };
  if (instances.size === 0) return empty;

  const first = instances.values().next().value!;
  const bound = first.bound_target;
  const bound_target = bound && typeof bound.host === "string" && typeof bound.port === "number"
    ? { host: bound.host, port: bound.port, label: String(bound.label ?? "") }
    : null;
  const tw = first.target_watcher;
  const target_watcher = tw === "enabled" || tw === "disabled" ? tw : null;

  return {
    replicas: instances.size,
    pool_size_per_replica: poolSizeFromInstances(instances),
    instance_ids: [...instances.keys()],
    live: true,
    bound_target,
    target_stale: typeof first.target_stale === "boolean" ? first.target_stale : null,
    target_watcher,
  };
}

export async function discoverBulkLoaderReplicaCount(
  fetchOne: () => Promise<BulkLoadStatusSnapshot>,
): Promise<number> {
  const topo = await discoverBulkLoaderTopology(fetchOne);
  return topo.replicas;
}

/** Fan-out attempts for lifecycle hooks (stop/start) — 2× live replicas, min 4. */
export function bulkLoaderFanOutAttempts(replicaCount: number): number {
  return Math.max(4, replicaCount * 2);
}
