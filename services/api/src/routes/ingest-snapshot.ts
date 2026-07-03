import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import type { RuntimeCategory } from "../active-target.ts";
import { getActiveTarget } from "../active-target.ts";
import { getSensKeyCountSnapshot } from "../lib/sens-key-count-cache.ts";
import {
  createBulkLoaderStatusFetch,
  discoverBulkLoaderTopology,
  fetchAggregatedBulkLoadStatus,
  sumFlushed,
  sumInFlight,
  type BulkLoadStatusSnapshot,
} from "../bulk-loader-topology.ts";
export interface BulkRunSnapshotInput {
  run_id: string;
  status: string;
  rows_total: number;
  rows_sent: number;
  rows_skipped: number;
  batch_size: number;
  concurrency: number;
  workers: number;
  started_at_iso: string;
  ms: number;
  bulk_loader_base: string;
  error?: string;
  flushed_at_start: number | null;
  throttled?: boolean;
  retries_total?: number;
}

export type RunPhase =
  | "producing"
  | "writing"
  | "throttled"
  | "draining"
  | "complete"
  | "error"
  | "cancelled";

export interface SnapshotRun {
  run_id: string;
  status: string;
  rows_total: number;
  rows_sent: number;
  rows_written: number;
  rows_per_sec_producer: number;
  rows_per_sec_write: number;
  phase: RunPhase;
  workers: number;
  started_at_iso: string;
  throttled?: boolean;
  retries_total?: number;
  error?: string;
}

export interface IngestSnapshotResponse {
  ok: true;
  target_label: string;
  cluster: {
    sens_count: number;
    sens_count_refreshing: boolean;
    memory_bytes: number;
    memory_human: string;
  };
  loader: {
    in_flight: number;
    flush_rps: number;
    flushed_total: number;
    throttled: boolean;
    recent_429_count: number;
  };
  runs: SnapshotRun[];
  focused_run_id: string | null;
}

function parseInfoMemory(text: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const raw = line.slice(idx + 1);
    const num = Number(raw);
    out[key] = Number.isFinite(num) ? num : raw;
  }
  return out;
}

export function computeRowsWritten(
  flushedTotal: number,
  flushedAtStart: number | null | undefined,
): number {
  if (flushedAtStart == null) return 0;
  return Math.max(0, flushedTotal - flushedAtStart);
}

const runWrittenHighWater = new Map<string, number>();

/** Phase-aware monotonic rows_written — tolerates flaky bulk-loader aggregation. */
export function stabilizeRunRowsWritten(
  runId: string,
  run: {
    status: string;
    rows_sent: number;
    rows_total: number;
    phase?: RunPhase;
  },
  rawWritten: number,
): number {
  const total = Number.isFinite(run.rows_total) && run.rows_total > 0 ? run.rows_total : 0;
  const sent = Math.max(0, run.rows_sent);
  const written = Number.isFinite(rawWritten) && rawWritten >= 0 ? rawWritten : 0;
  const prev = runWrittenHighWater.get(runId) ?? 0;

  const inWritingPhase = run.phase === "writing" || run.phase === "draining"
    || (total > 0 && sent >= total);

  let raw: number;
  if (inWritingPhase) {
    raw = written > 0 ? written : sent;
  } else {
    raw = Math.max(sent, written);
  }
  if (total > 0) raw = Math.min(total, raw);

  const next = Math.max(prev, raw);
  if (run.status !== "running") {
    runWrittenHighWater.delete(runId);
  } else {
    runWrittenHighWater.set(runId, next);
  }
  return next;
}

export function computeRunPhase(
  run: { status: string; rows_total: number; rows_sent: number; rows_written: number },
  loader: { throttled: boolean; in_flight: number },
): RunPhase {
  if (run.status === "error") return "error";
  if (run.status === "cancelled") return loader.in_flight > 0 ? "draining" : "cancelled";
  if (run.status === "done" && run.rows_written >= run.rows_total) return "complete";
  if (loader.throttled) return "throttled";
  if (run.rows_sent >= run.rows_total && run.rows_written < run.rows_total) return "writing";
  if (run.rows_written < run.rows_total) return "producing";
  return "complete";
}

/** Minimum window between flush samples — avoids spike rates from sub-second polls. */
const MIN_FLUSH_DT_SEC = 0.5;

let prevFlushedTotal = 0;
let prevFlushAtMs = 0;
let flushRpsSmoothed = 0;

const runWriteSamples = new Map<string, { written: number; at: number }>();

/** Pure helper — exported for unit tests. */
export function computeFlushRpsFromDelta(
  delta: number,
  dtSec: number,
): number {
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  if (!Number.isFinite(dtSec) || dtSec < MIN_FLUSH_DT_SEC) return 0;
  return Math.round(delta / dtSec);
}

function updateFlushRps(flushedTotal: number, now: number): number {
  if (prevFlushAtMs > 0) {
    const dt = (now - prevFlushAtMs) / 1000;
    const delta = flushedTotal - prevFlushedTotal;
    flushRpsSmoothed = computeFlushRpsFromDelta(delta, dt);
  }
  prevFlushedTotal = flushedTotal;
  prevFlushAtMs = now;
  return flushRpsSmoothed;
}

function isLoaderActivelyWriting(
  runs: SnapshotRun[],
  inFlight: number,
): boolean {
  if (inFlight > 0) return true;
  return runs.some((r) => r.status === "running");
}

function computeRunWriteRps(runId: string, rowsWritten: number, now: number): number {
  const prev = runWriteSamples.get(runId);
  runWriteSamples.set(runId, { written: rowsWritten, at: now });
  if (!prev) return 0;
  const dt = (now - prev.at) / 1000;
  const delta = rowsWritten - prev.written;
  if (dt <= 0 || delta <= 0) return 0;
  return Math.round(delta / dt);
}

function pruneRunWriteSamples(activeIds: Set<string>): void {
  for (const id of runWriteSamples.keys()) {
    if (!activeIds.has(id)) runWriteSamples.delete(id);
  }
}

function producerRps(record: BulkRunSnapshotInput): number {
  if (record.status !== "running" || record.ms <= 0) return 0;
  return Math.round((record.rows_sent * 1000) / record.ms);
}

export function buildSnapshotRun(
  record: BulkRunSnapshotInput,
  loader: BulkLoadStatusSnapshot,
  flushedTotal: number,
  now: number,
): SnapshotRun {
  const rows_written = Math.min(
    record.rows_total,
    computeRowsWritten(flushedTotal, record.flushed_at_start),
  );
  const phase = computeRunPhase(
    {
      status: record.status,
      rows_total: record.rows_total,
      rows_sent: record.rows_sent,
      rows_written,
    },
    { throttled: loader.throttled === true, in_flight: sumInFlight(loader) },
  );
  return {
    run_id: record.run_id,
    status: record.status,
    rows_total: record.rows_total,
    rows_sent: record.rows_sent,
    rows_written,
    rows_per_sec_producer: producerRps(record),
    rows_per_sec_write: computeRunWriteRps(record.run_id, rows_written, now),
    phase,
    workers: record.workers,
    started_at_iso: record.started_at_iso,
    ...(record.throttled ? { throttled: true } : {}),
    ...(typeof record.retries_total === "number" ? { retries_total: record.retries_total } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function pickFocusedRunId(runs: SnapshotRun[]): string | null {
  const running = runs.filter((r) => r.status === "running");
  if (running.length > 0) {
    return running.sort((a, b) => b.started_at_iso.localeCompare(a.started_at_iso))[0]!.run_id;
  }
  if (runs.length === 0) return null;
  return runs.sort((a, b) => b.started_at_iso.localeCompare(a.started_at_iso))[0]!.run_id;
}

export interface BuildIngestSnapshotOpts {
  bulkBase: string;
  fetchImpl?: typeof fetch;
  getRedis: (category?: RuntimeCategory) => RedisLike | Promise<RedisLike>;
  listRuns: () => BulkRunSnapshotInput[];
  poolCategory?: RuntimeCategory;
}

export async function buildIngestSnapshot(opts: BuildIngestSnapshotOpts): Promise<IngestSnapshotResponse> {
  let target_label = "";
  try { target_label = getActiveTarget().label; } catch { /* no active target */ }

  const redis = await opts.getRedis(opts.poolCategory);
  const sens = target_label
    ? await getSensKeyCountSnapshot(target_label, redis)
    : { count: 0, refreshing: false, index_name: null };

  let memory_bytes = 0;
  let memory_human = "0B";
  try {
    const memText = await redis.info("memory");
    const parsed = parseInfoMemory(memText);
    memory_bytes = Number(parsed.used_memory ?? 0);
    const human = parsed.used_memory_human;
    memory_human = typeof human === "string" ? human : `${memory_bytes}B`;
  } catch { /* tolerate unreachable redis */ }

  const fetchOne = createBulkLoaderStatusFetch({
    base: opts.bulkBase,
    fetchImpl: opts.fetchImpl,
  });
  let loaderSnap: BulkLoadStatusSnapshot = { workers: [] };
  try {
    const topo = await discoverBulkLoaderTopology(fetchOne);
    loaderSnap = await fetchAggregatedBulkLoadStatus(fetchOne, topo.replicas);
  } catch { /* bulk-loader unreachable */ }

  const flushedTotal = sumFlushed(loaderSnap);
  const now = Date.now();
  const records = opts.listRuns();
  const runs = records.map((r) => {
    const snap = buildSnapshotRun(r, loaderSnap, flushedTotal, now);
    return {
      ...snap,
      rows_written: stabilizeRunRowsWritten(r.run_id, {
        status: r.status,
        rows_sent: r.rows_sent,
        rows_total: r.rows_total,
        phase: snap.phase,
      }, snap.rows_written),
    };
  });
  pruneRunWriteSamples(new Set(runs.map((r) => r.run_id)));

  const inFlight = sumInFlight(loaderSnap);
  let flush_rps = updateFlushRps(flushedTotal, now);
  if (!isLoaderActivelyWriting(runs, inFlight)) {
    flush_rps = 0;
  }

  return {
    ok: true,
    target_label,
    cluster: {
      sens_count: sens.count,
      sens_count_refreshing: sens.refreshing,
      memory_bytes,
      memory_human,
    },
    loader: {
      in_flight: inFlight,
      flush_rps,
      flushed_total: flushedTotal,
      throttled: loaderSnap.throttled === true,
      recent_429_count: loaderSnap.recent_429_count ?? 0,
    },
    runs,
    focused_run_id: pickFocusedRunId(runs),
  };
}

export function registerIngestSnapshotRoute(
  app: FastifyInstance,
  opts: BuildIngestSnapshotOpts,
): void {
  app.get("/ingest/snapshot", { config: { category: "light" } }, async (req) => {
    return buildIngestSnapshot({
      ...opts,
      poolCategory: req.poolCategory,
    });
  });
}

/** Test seam — reset flush-rate state between tests. */
export function _testResetIngestSnapshotState(): void {
  prevFlushedTotal = 0;
  prevFlushAtMs = 0;
  flushRpsSmoothed = 0;
  runWriteSamples.clear();
  runWrittenHighWater.clear();
}
