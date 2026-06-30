// Wave 7.0.9 — short bulk-ingest benchmark sweep to recommend worker count
// and surface saturation (Redis vs bulk-loader queue) for the active target.

import { availableParallelism } from "node:os";
import { getActiveTarget } from "../active-target.ts";
import { parseClusterInfo } from "@frtb/generator";
import {
  getBulkRunRecord,
  getIngestRuntime,
  hasRunningBulkRuns,
  startBulkIngestRun,
} from "../routes/ingest.ts";
import { hasRunningGeneratorRuns } from "../routes/generator.ts";
import {
  createBulkLoaderStatusFetch,
  discoverBulkLoaderTopology,
  fetchAggregatedBulkLoadStatus,
  sumFlushed,
  type BulkLoadStatusSnapshot,
} from "../bulk-loader-topology.ts";

export type { BulkLoadStatusSnapshot } from "../bulk-loader-topology.ts";
export {
  discoverBulkLoaderReplicaCount,
  discoverBulkLoaderTopology,
  fetchAggregatedBulkLoadStatus,
  probeBulkLoaderInstances,
  sumFlushed,
} from "../bulk-loader-topology.ts";

export type CapacityBottleneck =
  | "redis_write"
  | "bulk_loader_queue"
  | "balanced"
  | "under_utilized";

export type CapacityStepVerdict = "optimal" | "under_utilized" | "saturated";

export interface CapacityStepResult {
  workers: number;
  gen_rps: number;
  write_rps: number;
  throttled_samples: number;
  total_samples: number;
  recent_429_max: number;
  duration_ms: number;
  rows_sent: number;
  verdict: CapacityStepVerdict;
}

export interface CapacityTestDeployment {
  cores: number;
  recommended_max_workers: number;
  bulk_loader_pool_size: number;
  /** Live replica count from /load/status instance_id discovery (dynamic scale). */
  bulk_loader_replicas: number;
  bulk_loader_instance_ids: string[];
  /** Suggested `docker compose up -d --scale bulk-loader=N` value from the sweep. */
  recommended_bulk_loader_replicas: number;
  shards: number | null;
}

export interface CapacityTestResult {
  ok: true;
  target_label: string | null;
  deployment: CapacityTestDeployment;
  worker_sweep: number[];
  rows_per_step: number;
  steps: CapacityStepResult[];
  recommended_workers: number;
  bottleneck: CapacityBottleneck;
  notes: string[];
  total_ms: number;
}

export interface CapacityTestError {
  ok: false;
  status: number;
  error: string;
}

export type CapacityTestResponse = CapacityTestResult | CapacityTestError;

export interface CapacityTestOptions {
  rows_per_step?: number;
  worker_sweep?: number[];
  poll_ms?: number;
  step_timeout_ms?: number;
  pause_between_steps_ms?: number;
  /** Redis master shard count when known (cluster targets). */
  shards?: number | null;
  fetchBulkLoadStatus?: () => Promise<BulkLoadStatusSnapshot>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_SWEEP = [2, 4, 6, 8];
const DEFAULT_ROWS = 50_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_STEP_TIMEOUT_MS = 180_000;
const DEFAULT_PAUSE_MS = 2_000;
/** Docker default: 8 ingest workers across 4 bulk-loader replicas. */
const DEFAULT_WORKERS_PER_REPLICA = 2;
const MAX_BULK_LOADER_REPLICAS = 16;
/** Write RPS must be within this band of gen RPS to trust gen-vs-write comparison. */
const WRITE_TRUST_MIN_GEN_RATIO = 0.15;
const WRITE_TRUST_MAX_GEN_RATIO = 1.05;

/** True when flush-derived write RPS is usable for saturation / scaling math. */
export function isWriteRpsTrustworthy(genRps: number, writeRps: number): boolean {
  if (genRps <= 0 || writeRps <= 0) return false;
  return writeRps >= genRps * WRITE_TRUST_MIN_GEN_RATIO
    && writeRps <= genRps * WRITE_TRUST_MAX_GEN_RATIO;
}

function sanitizeWriteRps(genRps: number, pollWriteRps: number, windowWriteRps: number): number {
  let write = pollWriteRps > 0 ? pollWriteRps : windowWriteRps;
  if (!isWriteRpsTrustworthy(genRps, write)) return 0;
  return Math.round(write);
}

/**
 * Derive a concrete `--scale bulk-loader=N` from sweep metrics.
 * - bulk_loader_queue: scale up by gen/write gap at the saturated step.
 * - redis_write: extra replicas won't help — keep current count.
 * - balanced / under_utilized: ~2 ingest workers per replica (compose default).
 */
export function computeRecommendedBulkLoaderReplicas(opts: {
  bottleneck: CapacityBottleneck;
  steps: CapacityStepResult[];
  recommended_workers: number;
  current_replicas: number;
  shards: number | null;
}): number {
  const current = Math.max(1, opts.current_replicas);
  const { bottleneck, steps, recommended_workers, shards } = opts;

  if (steps.length === 0) return current;

  if (bottleneck === "redis_write") {
    return current;
  }

  if (bottleneck === "bulk_loader_queue") {
    const with429 = steps.filter((s) => s.recent_429_max > 0);
    if (with429.length === 0) {
      return current;
    }
    const worst = with429.reduce((a, b) => (
      b.recent_429_max > a.recent_429_max ? b : a
    ), with429[0]!);
    const ratio = isWriteRpsTrustworthy(worst.gen_rps, worst.write_rps)
      ? Math.min(3, worst.gen_rps / worst.write_rps)
      : 1.5;
    const scaled = Math.ceil(current * Math.max(1.25, ratio));
    return Math.min(MAX_BULK_LOADER_REPLICAS, Math.max(current + 1, scaled));
  }

  let byWorkers = Math.max(1, Math.ceil(recommended_workers / DEFAULT_WORKERS_PER_REPLICA));
  if (shards != null && shards >= 4) {
    byWorkers = Math.max(byWorkers, Math.ceil(shards / 4));
  }
  const adequate = Math.min(MAX_BULK_LOADER_REPLICAS, byWorkers);
  // Already running enough replicas — don't suggest scale-down in v1.
  return Math.max(adequate, current);
}

function clampWorkersSweep(maxWorkers: number, sweep?: number[]): number[] {
  const cap = Math.max(1, maxWorkers);
  const base = sweep ?? DEFAULT_SWEEP;
  const out = [...new Set(base.map((w) => Math.min(cap, Math.max(1, w))))].sort((a, b) => a - b);
  return out.length > 0 ? out : [Math.min(2, cap)];
}

function meanLast(samples: number[], n: number): number {
  if (samples.length === 0) return 0;
  const slice = samples.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function classifyStep(
  genRps: number,
  writeRps: number,
  throttledPct: number,
  recent429Max: number,
): CapacityStepVerdict {
  void throttledPct;
  if (recent429Max > 0) return "saturated";
  if (isWriteRpsTrustworthy(genRps, writeRps) && writeRps >= genRps * 0.95) {
    return "optimal";
  }
  return "under_utilized";
}

/** True when gen RPS falls after the peak step — API producer oversubscription. */
export function isProducerOversubscribed(steps: CapacityStepResult[]): boolean {
  if (steps.length < 2) return false;
  const peak = steps.reduce((a, b) => (b.gen_rps > a.gen_rps ? b : a), steps[0]!);
  const maxWorkers = Math.max(...steps.map((s) => s.workers));
  if (peak.workers >= maxWorkers) return false;
  return steps
    .filter((s) => s.workers > peak.workers)
    .every((s) => s.gen_rps < peak.gen_rps * 0.9);
}

/**
 * Redis write ceiling — only when multiple high-worker steps show a trustworthy,
 * plateauing write RPS while gen RPS is not collapsing (avoids short-step noise).
 */
export function detectRedisWriteCeiling(steps: CapacityStepResult[]): boolean {
  const trusted = steps.filter((s) => isWriteRpsTrustworthy(s.gen_rps, s.write_rps));
  if (trusted.length < 2) return false;

  const minWorkers = Math.min(...steps.map((s) => s.workers));
  const highWorkerTrusted = trusted.filter((s) => s.workers >= minWorkers + 2);
  if (highWorkerTrusted.length < 2) return false;

  const bestWrite = highWorkerTrusted.reduce((a, b) => (b.write_rps > a.write_rps ? b : a), highWorkerTrusted[0]!);
  const plateauSteps = highWorkerTrusted.filter((s) => s.write_rps >= bestWrite.write_rps * 0.95);
  if (plateauSteps.length < 2) return false;

  const peakGen = Math.max(...steps.map((s) => s.gen_rps));
  const minGenOnPlateau = Math.min(...plateauSteps.map((s) => s.gen_rps));
  return minGenOnPlateau >= peakGen * 0.85;
}

export function pickRecommendation(steps: CapacityStepResult[]): {
  recommended_workers: number;
  bottleneck: CapacityBottleneck;
} {
  if (steps.length === 0) {
    return { recommended_workers: 2, bottleneck: "under_utilized" };
  }

  const peak = steps.reduce((a, b) => (b.gen_rps > a.gen_rps ? b : a), steps[0]!);
  const recommended_workers = peak.workers;

  if (steps.some((s) => s.recent_429_max > 0)) {
    return { recommended_workers, bottleneck: "bulk_loader_queue" };
  }

  if (detectRedisWriteCeiling(steps)) {
    return { recommended_workers, bottleneck: "redis_write" };
  }

  if (isProducerOversubscribed(steps)) {
    return { recommended_workers, bottleneck: "under_utilized" };
  }

  if (steps.some((s) => s.verdict === "optimal")) {
    return { recommended_workers, bottleneck: "balanced" };
  }

  return { recommended_workers, bottleneck: "under_utilized" };
}

function buildRecommendationNotes(opts: {
  bottleneck: CapacityBottleneck;
  current_replicas: number;
  recommended_replicas: number;
  recommended_workers: number;
  producer_oversubscribed?: boolean;
}): string[] {
  const notes: string[] = [];
  const { bottleneck, current_replicas, recommended_replicas, recommended_workers, producer_oversubscribed } = opts;
  const scaleCmd = `docker compose up -d --scale bulk-loader=${recommended_replicas}`;

  switch (bottleneck) {
    case "bulk_loader_queue":
      if (recommended_replicas > current_replicas) {
        notes.push(
          `Bulk-loader returned 429s during the sweep — scale from ${current_replicas} to ${recommended_replicas} replica(s): ${scaleCmd}`,
        );
      } else {
        notes.push(
          `Bulk-loader returned 429s — try ${recommended_replicas} replica(s) or fewer ingest workers before raising BULK_LOADER_POOL_SIZE.`,
        );
      }
      break;
    case "redis_write":
      notes.push(
        `Write RPS plateaued on multiple high-worker steps — Redis ingest may be the ceiling. Keeping bulk-loader at ${current_replicas} replica(s).`,
      );
      break;
    case "under_utilized":
      if (producer_oversubscribed) {
        notes.push(
          `Gen RPS peaks at ${recommended_workers} ingest workers — higher counts oversubscribe the API producer. Current ${current_replicas} bulk-loader replica(s) is sufficient.`,
        );
      } else {
        notes.push(
          `Headroom remains — use ${recommended_workers} ingest workers; current ${current_replicas} bulk-loader replica(s) is sufficient.`,
        );
      }
      break;
    default:
      notes.push(
        `Producer and write rates look balanced — keep ${current_replicas} bulk-loader replica(s) with ${recommended_workers} ingest workers.`,
      );
  }

  return notes;
}

async function defaultFetchBulkLoadStatus(
  replicaCount?: number,
): Promise<BulkLoadStatusSnapshot> {
  const ctx = getIngestRuntime();
  if (!ctx) throw new Error("ingest runtime not configured");
  const fetchOne = async (): Promise<BulkLoadStatusSnapshot> => {
    const res = await ctx.fetchImpl(`${ctx.bulkBase}/load/status`, { method: "GET" });
    if (!res.ok) throw new Error(`bulk-loader /load/status ${res.status}`);
    return (await res.json()) as BulkLoadStatusSnapshot;
  };
  return fetchAggregatedBulkLoadStatus(fetchOne, replicaCount);
}

async function runStep(
  workers: number,
  rowsPerStep: number,
  pollMs: number,
  stepTimeoutMs: number,
  fetchBulkLoadStatus: () => Promise<BulkLoadStatusSnapshot>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<CapacityStepResult> {
  const ctx = getIngestRuntime();
  if (!ctx) throw new Error("ingest runtime not configured");

  const started = startBulkIngestRun(ctx, { rows: rowsPerStep, workers });
  if (!started.ok) throw new Error(started.error);

  const run_id = started.run_id;
  const t0 = now();
  let lastFlushed = 0;
  let lastFlushedAt = t0;
  let flushedAtStart = 0;
  const genRpsSamples: number[] = [];
  const writeRpsSamples: number[] = [];
  let throttledSamples = 0;
  let totalSamples = 0;
  let recent429Max = 0;

  try {
    const load0 = await fetchBulkLoadStatus().catch(() => ({ workers: [] }));
    flushedAtStart = sumFlushed(load0);
    lastFlushed = flushedAtStart;
    lastFlushedAt = now();

    while (true) {
      await sleep(pollMs);
      const record = getBulkRunRecord(run_id);
      if (!record) break;

      const elapsed = now() - t0;
      let load: BulkLoadStatusSnapshot = {};
      try {
        load = await fetchBulkLoadStatus();
      } catch { /* tolerate */ }

      const flushed = sumFlushed(load);
      const dt = Math.max(1, now() - lastFlushedAt);
      const writeRps = ((flushed - lastFlushed) * 1000) / dt;
      if (flushed >= lastFlushed) {
        lastFlushed = flushed;
        lastFlushedAt = now();
      }

      const genRps = record.ms > 0
        ? Math.round((record.rows_sent * 1000) / record.ms)
        : 0;

      genRpsSamples.push(genRps);
      writeRpsSamples.push(Math.max(0, writeRps));
      totalSamples += 1;
      if (load.throttled) throttledSamples += 1;
      recent429Max = Math.max(recent429Max, load.recent_429_count ?? 0);

      if (record.status !== "running") {
        const loadEnd = await fetchBulkLoadStatus().catch(() => ({ workers: [] }));
        return finalizeStep(
          workers,
          record.rows_sent,
          elapsed,
          genRpsSamples,
          writeRpsSamples,
          throttledSamples,
          totalSamples,
          recent429Max,
          flushedAtStart,
          sumFlushed(loadEnd),
        );
      }

      if (elapsed >= stepTimeoutMs) {
        const loadEnd = await fetchBulkLoadStatus().catch(() => ({ workers: [] }));
        return finalizeStep(
          workers,
          record.rows_sent,
          elapsed,
          genRpsSamples,
          writeRpsSamples,
          throttledSamples,
          totalSamples,
          recent429Max,
          flushedAtStart,
          sumFlushed(loadEnd),
        );
      }
    }
  } finally {
    const record = getBulkRunRecord(run_id);
    if (record?.status === "running") {
      record.cancelled = true;
      record.status = "cancelled";
      if (record.cancelView) Atomics.store(record.cancelView, 0, 1);
      if (record.httpAbort && !record.httpAbort.signal.aborted) record.httpAbort.abort();
      if (record.workerHandles) {
        for (const w of record.workerHandles) void w.terminate();
      }
    }
  }

  return finalizeStep(
    workers, 0, now() - t0, genRpsSamples, writeRpsSamples,
    throttledSamples, totalSamples, recent429Max, flushedAtStart, lastFlushed,
  );
}

function finalizeStep(
  workers: number,
  rowsSent: number,
  durationMs: number,
  genRpsSamples: number[],
  writeRpsSamples: number[],
  throttledSamples: number,
  totalSamples: number,
  recent429Max: number,
  flushedAtStart: number,
  flushedAtEnd: number,
): CapacityStepResult {
  const genRps = Math.round(meanLast(genRpsSamples, 5));
  const pollWriteRps = Math.round(meanLast(writeRpsSamples, 5));
  const windowWriteRps = durationMs > 0
    ? Math.round(((flushedAtEnd - flushedAtStart) * 1000) / durationMs)
    : 0;
  const writeRps = sanitizeWriteRps(genRps, pollWriteRps, windowWriteRps);
  const throttledPct = totalSamples > 0 ? throttledSamples / totalSamples : 0;
  const verdict = classifyStep(genRps, writeRps, throttledPct, recent429Max);
  return {
    workers,
    gen_rps: genRps,
    write_rps: writeRps,
    throttled_samples: throttledSamples,
    total_samples: totalSamples,
    recent_429_max: recent429Max,
    duration_ms: Math.round(durationMs),
    rows_sent: rowsSent,
    verdict,
  };
}

export async function runIngestCapacityTest(
  opts: CapacityTestOptions = {},
): Promise<CapacityTestResponse> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const rowsPerStep = opts.rows_per_step ?? DEFAULT_ROWS;
  const pollMs = opts.poll_ms ?? DEFAULT_POLL_MS;
  const stepTimeoutMs = opts.step_timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
  const pauseMs = opts.pause_between_steps_ms ?? DEFAULT_PAUSE_MS;

  const t0 = now();

  if (hasRunningBulkRuns() || hasRunningGeneratorRuns()) {
    return { ok: false, status: 409, error: "ingest or generator run already active — stop it before running a capacity test" };
  }

  const ctx = getIngestRuntime();
  if (!ctx?.schema) {
    return { ok: false, status: 503, error: "schema not loaded — cannot run capacity test" };
  }

  let bulk_loader_replicas = 1;
  let bulk_loader_pool_size = 32;
  let bulk_loader_instance_ids: string[] = [];

  const defaultFetchOne = async (): Promise<BulkLoadStatusSnapshot> => {
    const res = await ctx.fetchImpl(`${ctx.bulkBase}/load/status`, { method: "GET" });
    if (!res.ok) throw new Error(`bulk-loader /load/status ${res.status}`);
    return (await res.json()) as BulkLoadStatusSnapshot;
  };

  if (!opts.fetchBulkLoadStatus) {
    const topo = await discoverBulkLoaderTopology(defaultFetchOne);
    bulk_loader_replicas = topo.replicas;
    bulk_loader_pool_size = topo.pool_size_per_replica;
    bulk_loader_instance_ids = topo.instance_ids;
  }

  const fetchBulkLoadStatus = opts.fetchBulkLoadStatus
    ?? (() => defaultFetchBulkLoadStatus(bulk_loader_replicas));

  let target_label: string | null = null;
  try {
    target_label = getActiveTarget().label || null;
  } catch { /* no target */ }

  const cores = Math.max(1, availableParallelism());
  const recommended_max_workers = Math.max(1, cores - 2);
  const shards = opts.shards ?? null;

  const workerSweep = clampWorkersSweep(recommended_max_workers, opts.worker_sweep);

  const steps: CapacityStepResult[] = [];
  const notes: string[] = [
    `Each step ingests ${rowsPerStep.toLocaleString("en-US")} rows via the bulk-loader fast path.`,
    `Live topology: ${bulk_loader_replicas} bulk-loader replica(s), pool ${bulk_loader_pool_size} per container.`,
    `Scale with: docker compose up -d --scale bulk-loader=N (discovered automatically on the next test).`,
    `Tune pool per container via BULK_LOADER_POOL_SIZE when replica count alone isn't enough.`,
  ];

  for (let i = 0; i < workerSweep.length; i++) {
    const workers = workerSweep[i]!;
    if (hasRunningBulkRuns()) {
      notes.push(`Stopped sweep early — a bulk run was still active before workers=${workers}.`);
      break;
    }
    try {
      const step = await runStep(workers, rowsPerStep, pollMs, stepTimeoutMs, fetchBulkLoadStatus, sleep, now);
      steps.push(step);
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (i < workerSweep.length - 1) await sleep(pauseMs);
  }

  const { recommended_workers, bottleneck } = pickRecommendation(steps);
  const recommended_bulk_loader_replicas = computeRecommendedBulkLoaderReplicas({
    bottleneck,
    steps,
    recommended_workers,
    current_replicas: bulk_loader_replicas,
    shards,
  });
  const recNotes = buildRecommendationNotes({
    bottleneck,
    current_replicas: bulk_loader_replicas,
    recommended_replicas: recommended_bulk_loader_replicas,
    recommended_workers,
    producer_oversubscribed: isProducerOversubscribed(steps),
  });
  if (steps.length === 0) {
    recNotes.unshift("no steps completed");
  }

  return {
    ok: true,
    target_label,
    deployment: {
      cores,
      recommended_max_workers,
      bulk_loader_pool_size,
      bulk_loader_replicas,
      bulk_loader_instance_ids,
      recommended_bulk_loader_replicas,
      shards,
    },
    worker_sweep: workerSweep,
    rows_per_step: rowsPerStep,
    steps,
    recommended_workers,
    bottleneck,
    notes: [...notes, ...recNotes],
    total_ms: now() - t0,
  };
}
