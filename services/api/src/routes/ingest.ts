// Wave 7.0.6.13 — bulk-loader ingest fast path.
//
import {
  bulkLoaderFanOutAttempts,
  createBulkLoaderStatusFetch,
  discoverBulkLoaderTopology,
  fetchAggregatedBulkLoadStatus,
  sumFlushed,
} from "../bulk-loader-topology.ts";
import type { RedisLike } from "../redis-like.ts";
import type { RuntimeCategory } from "../active-target.ts";
import {
  buildSnapshotRun,
  registerIngestSnapshotRoute,
  stabilizeRunRowsWritten,
} from "./ingest-snapshot.ts";
import {
  archiveBulkRunHistory,
  getRunHistoryEntry,
  listRunHistory,
} from "../lib/ingest-run-history.ts";
//
// POST /ingest/bulk/start drives the bulk-loader (POST :8086/load/rows) with
// a generated row stream so the UI's "Start ingest" button can bypass the
// latency-bound stream consumer (XADD sensitivities:in → per-row WATCH/MULTI
// path) and saturate the dispatcher's pipelined HSETs.
//
// GET  /ingest/bulk/runs/:run_id  → tracked producer-side counters for one run
// GET  /ingest/bulk/load-status   → server-side proxy of bulk-loader /load/status
//                                   (browser cannot reach :8086 directly)
//
// Wave 7.0.6.15 — multi-worker fan-out. `workers > 1` spawns N worker_threads
// (reusing services/generator/src/worker.ts via the worker-entry.mjs shim) so
// V8 row synthesis runs in parallel across cores. workers=1 stays on the
// inline path so the existing single-worker bit-equivalence canary holds.
// POST /ingest/bulk/cancel flips a SharedArrayBuffer flag the workers poll
// every 1024 rows; the inline path checks `record.cancelled` on the same
// boundary so the cancel surface is identical for both.

import { ulid } from "ulid";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import {
  createRowGenerator,
  createHttpProducer,
  workerEntryUrl,
  type WorkerInitData,
  type WorkerMessage,
} from "@frtb/generator";

export interface IngestRoutesOpts {
  // Override bulk-loader base URL. Falls back to BULK_LOADER_URL env, then
  // to BULK_LOADER_PORT (compose-internal default 8086).
  bulkLoaderBase?: string;
  // Test seam — defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Wave 7.0.6.15 — absolute path to the schema YAML, required when
  // `workers > 1` (each worker_threads child reloads it locally because
  // `Schema` is not structured-clonable). Falls back to $SCHEMA_FILE or the
  // repo-root default, mirroring services/api/src/index.ts.
  schemaPath?: string;
  // Redis accessor for GET /ingest/snapshot (cluster stats).
  getRedis?: (category?: RuntimeCategory) => RedisLike | Promise<RedisLike>;
  // Wave 7.0.6.15 — host parallelism override (test seam). Defaults to
  // node:os.availableParallelism().
  availableCores?: () => number;
}

interface BulkRunBody {
  rows?: number;
  // Accept both naming conventions to match the task spec ("rowsTotal") and
  // the existing /generator/start body ("rows"). Whichever is provided wins.
  rowsTotal?: number;
  batch_size?: number;
  concurrency?: number;
  classes?: string[];
  sensitivity_types?: string[];
  seed?: string | number;
  trade_pool_size?: number;
  factor_pool_size?: number;
  // Wave 7.0.6.15 — number of worker_threads to fan out across. 1 (default)
  // preserves the inline single-worker path bit-equivalence canary; >1
  // spawns workers that each own 1/N of the row picker via stride
  // partitioning (row `i` → worker `i % N`).
  workers?: number;
}

interface BulkRunRecord {
  run_id: string;
  status: "running" | "done" | "error" | "cancelled";
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
  /** Aggregated bulk-loader flushed count at run start (rows_written baseline). */
  flushed_at_start: number | null;
  // Wave 7.0.6.15 — co-located cancel surface. SAB for workers>1 (workers
  // poll Atomics.load(cancelView, 0)); `cancelled` flag for inline.
  cancelView?: Int32Array;
  cancelled?: boolean;
  // Immediate abort for inline runs (workers=1) and worker termination for
  // multi-worker runs — set by cancel handlers so in-flight HTTP retries
  // unwind without waiting for the next row-boundary poll.
  httpAbort?: AbortController;
  workerHandles?: Worker[];
  // Wave 7.0.6.22 — bulk-load backpressure surface for the UI rate-gauge.
  //   throttled       true while at least one in-flight batch on any worker
  //                   is in the 429 retry loop.
  //   retries_total   monotonic count of retry attempts (429 + 5xx + network)
  //                   summed across all workers for this run.
  //   throttled_at_ms wall-clock ms of the most recent 429 across any worker,
  //                   or null when no 429 has been observed this run.
  // Per-worker maps are kept on the record so progress messages can update
  // a slot without losing the other workers' contributions; the wire shape
  // (the GET /ingest/bulk/runs/:id response) reports only the aggregates.
  throttled?: boolean;
  retries_total?: number;
  throttled_at_ms?: number | null;
  perWorkerThrottled?: boolean[];
  perWorkerRetries?: number[];
  perWorkerThrottledAt?: Array<number | null>;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 32;
const MAX_BATCH_SIZE = 10_000;
const MAX_CONCURRENCY = 256;
// Wave 7.0.6.15 — hard cap on workers, matching the generator CLI. The host-
// info endpoint additionally suggests `cores - 2` so the UI defaults stay
// inside the headroom even on large hosts.
const MAX_WORKERS = 32;
// Schema-defined risk class IDs (config/schema/frtb-default.yaml `risk_classes`)
// — names must match exactly or createRowGenerator throws "risk class X not
// defined in schema". Defaulting to GIRR + EQUITY covers the two SBM smokes
// the operator runs after a fresh ingest (GIRR Delta, EQUITY Delta).
const DEFAULT_CLASSES = ["GIRR", "EQUITY", "FX"] as const;
// Wave 7.0.6.19 — include Curvature in the bulk-ingest default so the
// verifier's 5-combo calc smoke (GIRR Δ/Vega/Curv, EQUITY Δ, FX Δ) has all
// the rows it needs after a stock POST /ingest/bulk/start (the /generator/
// start route already defaulted to ["Delta","Vega","Curvature"]).
const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega", "Curvature"] as const;
// Bulk-loader-only retention; the UI polls /ingest/bulk/runs/:id while a run
// is in flight and a few seconds after completion, then drops the handle.
const RUN_GRACE_MS = 60_000;

// Logger surface narrow enough that both fastify's pino instance and the
// console satisfy it without an explicit dependency on pino.
interface RouteLogger {
  warn: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

const activeRuns = new Map<string, BulkRunRecord>();

// Wave 7.0.9 — runtime context for ingest-capacity-test (same process).
export interface IngestRuntimeContext {
  schema: Schema | undefined;
  schemaPath: string | undefined;
  bulkBase: string;
  fetchImpl: typeof fetch;
  availableCores: () => number;
  log: RouteLogger;
}

let ingestRuntime: IngestRuntimeContext | null = null;

export function getIngestRuntime(): IngestRuntimeContext | null {
  return ingestRuntime;
}

export function hasRunningBulkRuns(): boolean {
  for (const r of activeRuns.values()) {
    if (r.status === "running") return true;
  }
  return false;
}

export function getBulkRunRecord(run_id: string): BulkRunRecord | undefined {
  return activeRuns.get(run_id);
}

export function getAllBulkRunRecords(): BulkRunRecord[] {
  return Array.from(activeRuns.values());
}

export function listActiveBulkIngestRuns(): Array<{
  run_id: string;
  status: string;
  rows_sent: number;
  rows_total: number;
  workers: number;
}> {
  return Array.from(activeRuns.values())
    .filter((r) => r.status === "running")
    .map((r) => ({
      run_id: r.run_id,
      status: r.status,
      rows_sent: r.rows_sent,
      rows_total: r.rows_total,
      workers: r.workers,
    }));
}

export type StartBulkIngestResult =
  | { ok: true; run_id: string; workers: number; rows_total: number }
  | { ok: false; status: number; error: string };

export async function captureBulkLoaderFlushBaseline(
  bulkBase: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  try {
    const fetchOne = createBulkLoaderStatusFetch({ base: bulkBase, fetchImpl });
    const topo = await discoverBulkLoaderTopology(fetchOne);
    const agg = await fetchAggregatedBulkLoadStatus(fetchOne, topo.replicas);
    return sumFlushed(agg);
  } catch {
    return null;
  }
}

export function startBulkIngestRun(
  ctx: IngestRuntimeContext,
  body: BulkRunBody,
  flushedAtStart: number | null = null,
): StartBulkIngestResult {
  const schema = ctx.schema;
  if (!schema) {
    return { ok: false, status: 503, error: "schema not loaded" };
  }
  const rowsTotal = pickInt(body.rowsTotal, body.rows);
  if (rowsTotal === undefined || !Number.isInteger(rowsTotal) || rowsTotal < 1) {
    return { ok: false, status: 400, error: "rows must be a positive integer" };
  }
  const batchSize = clamp(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const concurrency = clamp(body.concurrency ?? DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const requestedWorkers = pickInt(body.workers) ?? 1;
  const hostCores = Math.max(1, ctx.availableCores());
  const workers = clamp(
    Number.isInteger(requestedWorkers) ? requestedWorkers : 1,
    1,
    Math.min(MAX_WORKERS, hostCores),
  );
  const classes = (Array.isArray(body.classes) && body.classes.length > 0
    ? body.classes
    : [...DEFAULT_CLASSES]).map(String);
  const sensitivityTypes = Array.isArray(body.sensitivity_types) && body.sensitivity_types.length > 0
    ? body.sensitivity_types.map(String)
    : [...DEFAULT_SENSITIVITY_TYPES];

  const run_id = ulid();
  const started_at_iso = new Date().toISOString();
  const record: BulkRunRecord = {
    run_id,
    status: "running",
    rows_total: rowsTotal,
    rows_sent: 0,
    rows_skipped: 0,
    batch_size: batchSize,
    concurrency,
    workers,
    started_at_iso,
    ms: 0,
    bulk_loader_base: ctx.bulkBase,
    flushed_at_start: flushedAtStart,
  };
  activeRuns.set(run_id, record);

  if (workers === 1) {
    runInline({
      schema,
      body,
      rowsTotal,
      batchSize,
      concurrency,
      classes,
      sensitivityTypes,
      bulkBase: ctx.bulkBase,
      fetchImpl: ctx.fetchImpl,
      log: ctx.log,
      record,
      run_id,
    });
  } else {
    const schemaPath = ctx.schemaPath;
    if (!schemaPath) {
      activeRuns.delete(run_id);
      return { ok: false, status: 503, error: "schemaPath not resolvable for multi-worker run" };
    }
    runWithWorkers({
      schemaPath,
      body,
      rowsTotal,
      batchSize,
      concurrency,
      classes,
      sensitivityTypes,
      bulkBase: ctx.bulkBase,
      fetchImpl: ctx.fetchImpl,
      workers,
      log: ctx.log,
      record,
      run_id,
    });
  }

  return { ok: true, run_id, workers, rows_total: rowsTotal };
}

// Wave 7.0.8 — bulk-loader lifecycle hooks shared by cancel + stop-runs.
let bulkLoaderHaltBase = "";
let bulkLoaderHaltFetch: typeof fetch = globalThis.fetch;

function configureBulkLoaderHalt(base: string, fetchImpl: typeof fetch): void {
  bulkLoaderHaltBase = base.replace(/\/+$/, "");
  bulkLoaderHaltFetch = fetchImpl;
}

/** POST /load/stop on every replica (round-robin fan-out). */
export async function haltBulkLoaderAccept(): Promise<void> {
  if (!bulkLoaderHaltBase) return;
  const fetchOne = createBulkLoaderStatusFetch({
    base: bulkLoaderHaltBase,
    fetchImpl: bulkLoaderHaltFetch,
  });
  const topo = await discoverBulkLoaderTopology(fetchOne);
  const attempts = bulkLoaderFanOutAttempts(topo.replicas);
  await Promise.allSettled(
    Array.from({ length: attempts }, () =>
      bulkLoaderHaltFetch(`${bulkLoaderHaltBase}/load/stop`, { method: "POST" }),
    ),
  );
}

/** Re-enable bulk-loader after a deliberate stop (all replicas). */
export async function resumeBulkLoaderAccept(): Promise<void> {
  if (!bulkLoaderHaltBase) return;
  const fetchOne = createBulkLoaderStatusFetch({
    base: bulkLoaderHaltBase,
    fetchImpl: bulkLoaderHaltFetch,
  });
  try {
    const topo = await discoverBulkLoaderTopology(fetchOne);
    const attempts = bulkLoaderFanOutAttempts(topo.replicas);
    await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        bulkLoaderHaltFetch(`${bulkLoaderHaltBase}/load/start`, { method: "POST" }),
      ),
    );
  } catch {
    try {
      await bulkLoaderHaltFetch(`${bulkLoaderHaltBase}/load/start`, { method: "POST" });
    } catch { /* tolerate unreachable bulk-loader */ }
  }
}

function pickInt(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) {
    if (v !== undefined && Number.isFinite(v)) return v;
  }
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Wave 7.0.6.19 — sensitivity_type coverage floor. Each (risk_class,
// sensitivity_type) combo gets at least `globalFloor` emissions across the
// whole run so small smokes (rows=50k) reliably cover all 5 verifier combos
// (GIRR Δ/Vega/Curv, EQUITY Δ, FX Δ). Disabled for rows < 100 (the natural
// uniform draw already covers all combos at that scale, and the floor would
// dominate a sub-100-row run). Multi-worker callers divide by stride so the
// per-worker forced rows sum to ≥ globalFloor across the cluster.
function computeCoverageFloor(rowsTotal: number, workers: number): number {
  if (rowsTotal < 100) return 0;
  const globalFloor = Math.max(1, Math.floor(rowsTotal / 100));
  return Math.max(1, Math.ceil(globalFloor / Math.max(1, workers)));
}

// Wave 7.0.6.20 — compute the per-class row count a single worker will draw
// when iterating `for (i = offset; i < rowsTotal; i += stride)` with the
// `classes[i % classes.length]` round-robin. Threaded to the row-generator
// as `plannedRowsByClass` so the reallocation-based coverage floor can size
// per-(rc, sens_type) quotas that sum EXACTLY to the worker's row count
// (preserves the requested total instead of the 6.19 path's potential
// inflation when the floor exceeded the natural per-combo share).
function planRowsByClass(
  rowsTotal: number,
  classes: readonly string[],
  offset: number,
  stride: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of classes) counts[c] = 0;
  const C = classes.length;
  if (C === 0 || stride <= 0 || rowsTotal <= 0) return counts;
  for (let i = offset; i < rowsTotal; i += stride) {
    counts[classes[i % C]!] = (counts[classes[i % C]!] ?? 0) + 1;
  }
  return counts;
}

// Wave 7.0.6.15 — resolve the schema path the API was booted with. Tests
// that don't thread `schemaPath` through `registerIngestRoutes` fall back to
// $SCHEMA_FILE or the repo-root default; workers>1 rejects when no path
// resolves so we never silently load a different schema in a worker.
function resolveSchemaPath(opts: IngestRoutesOpts): string | undefined {
  if (opts.schemaPath) return opts.schemaPath;
  if (process.env.SCHEMA_FILE) return resolve(process.env.SCHEMA_FILE);
  // services/api/src/routes/ingest.ts → repo root = ../../../..
  const here = dirname(fileURLToPath(import.meta.url));
  const fallback = resolve(here, "../../../..", "config/schema/frtb-default.yaml");
  return fallback;
}

export function registerIngestRoutes(
  app: FastifyInstance,
  schema: Schema | undefined,
  opts: IngestRoutesOpts = {},
): void {
  const bulkBase = (opts.bulkLoaderBase
    ?? process.env.BULK_LOADER_URL
    ?? `http://localhost:${process.env.BULK_LOADER_PORT ?? 8086}`
  ).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const availableCores = opts.availableCores ?? availableParallelism;
  const schemaPath = resolveSchemaPath(opts);
  ingestRuntime = {
    schema,
    schemaPath,
    bulkBase,
    fetchImpl,
    availableCores,
    log: app.log,
  };
  configureBulkLoaderHalt(bulkBase, fetchImpl);

  app.post<{ Body: BulkRunBody }>(
    "/ingest/bulk/start",
    { config: { category: "heavy-ingest" } },
    async (req, reply) => {
      const body = (req.body ?? {}) as BulkRunBody;
      await resumeBulkLoaderAccept();
      const flushedAtStart = await captureBulkLoaderFlushBaseline(bulkBase, fetchImpl);
      const started = startBulkIngestRun(ingestRuntime!, body, flushedAtStart);
      if (!started.ok) {
        reply.code(started.status);
        return { ok: false, error: started.error };
      }
      const record = activeRuns.get(started.run_id)!;
      reply.code(202);
      return {
        ok: true,
        run_id: started.run_id,
        rows_total: started.rows_total,
        batch_size: record.batch_size,
        concurrency: record.concurrency,
        workers: started.workers,
        bulk_loader_base: bulkBase,
        started_at_iso: record.started_at_iso,
      };
    },
  );

  // Wave 7.0.6.15 — UI-driven cancel. Flips the SAB flag for workers>1 and
  // the inline `cancelled` boolean for workers=1. Both paths poll on the
  // same 1024-row boundary so wall-time-to-stop is ≤200ms at typical
  // row rates. Returns 404 for unknown ids, 409 for already-terminal runs.
  app.post<{ Body: { run_id?: string } }>(
    "/ingest/bulk/cancel",
    { config: { category: "light" } },
    async (req, reply) => {
      const run_id = (req.body ?? {}).run_id;
      if (!run_id || typeof run_id !== "string") {
        reply.code(400);
        return { ok: false, error: "run_id required" };
      }
      const r = activeRuns.get(run_id);
      if (!r) {
        reply.code(404);
        return { ok: false, error: "run not found" };
      }
      if (r.status !== "running") {
        reply.code(409);
        return { ok: false, error: `run already ${r.status}` };
      }
      applyBulkRunCancel(r);
      void haltBulkLoaderAccept();
      return { ok: true, run_id, status: "cancelled" };
    },
  );

  // Wave 7.0.8 — orphan discovery for UI reconnect after refresh (mirrors
  // GET /generator/runs). Returns running bulk-loader producer runs only.
  app.get(
    "/ingest/bulk/runs/history",
    { config: { category: "light" } },
    async () => ({ runs: listRunHistory() }),
  );

  app.get<{ Params: { run_id: string } }>(
    "/ingest/bulk/runs/history/:run_id",
    { config: { category: "light" } },
    async (req, reply) => {
      const entry = getRunHistoryEntry(req.params.run_id);
      if (!entry) {
        reply.code(404);
        return { error: "run not found in history" };
      }
      return entry;
    },
  );

  app.get(
    "/ingest/bulk/runs",
    { config: { category: "light" } },
    async () => {
      const running = Array.from(activeRuns.values()).filter((r) => r.status === "running");
      let loaderSnap: Awaited<ReturnType<typeof fetchAggregatedBulkLoadStatus>> = { workers: [] };
      let flushedTotal = 0;
      try {
        const fetchOne = createBulkLoaderStatusFetch({ base: bulkBase, fetchImpl });
        const topo = await discoverBulkLoaderTopology(fetchOne);
        loaderSnap = await fetchAggregatedBulkLoadStatus(fetchOne, topo.replicas);
        flushedTotal = sumFlushed(loaderSnap);
      } catch { /* bulk-loader unreachable — rows_written falls back to 0 */ }
      const now = Date.now();
      const active = running.map((r) => {
        const snap = buildSnapshotRun(r, loaderSnap, flushedTotal, now);
        const rows_written = stabilizeRunRowsWritten(r.run_id, {
          status: r.status,
          rows_sent: r.rows_sent,
          rows_total: r.rows_total,
          phase: snap.phase,
        }, snap.rows_written);
        return {
          run_id: r.run_id,
          status: r.status,
          rows_sent: r.rows_sent,
          rows_written,
          rows_total: r.rows_total,
          started_at_iso: r.started_at_iso,
          workers: r.workers,
          phase: snap.phase,
        };
      });
      return { active };
    },
  );

  app.get<{ Params: { run_id: string } }>(
    "/ingest/bulk/runs/:run_id",
    { config: { category: "light" } },
    async (req, reply) => {
      const r = activeRuns.get(req.params.run_id);
      if (!r) {
        reply.code(404);
        return { error: "run not found" };
      }
      const rps = r.status === "running" && r.ms > 0
        ? Math.round((r.rows_sent * 1000) / r.ms)
        : 0;
      const {
        cancelView: _cv,
        perWorkerThrottled: _pwt,
        perWorkerRetries: _pwr,
        perWorkerThrottledAt: _pwa,
        httpAbort: _ha,
        workerHandles: _wh,
        cancelled: _c,
        ...wireFields
      } = r;
      void _cv; void _pwt; void _pwr; void _pwa; void _ha; void _wh; void _c;

      let snapshotFields: Record<string, unknown> = {};
      try {
        const fetchOne = createBulkLoaderStatusFetch({ base: bulkBase, fetchImpl });
        const topo = await discoverBulkLoaderTopology(fetchOne);
        const agg = await fetchAggregatedBulkLoadStatus(fetchOne, topo.replicas);
        const snap = buildSnapshotRun(r, agg, sumFlushed(agg), Date.now());
        const rows_written = stabilizeRunRowsWritten(r.run_id, {
          status: r.status,
          rows_sent: r.rows_sent,
          rows_total: r.rows_total,
          phase: snap.phase,
        }, snap.rows_written);
        snapshotFields = {
          rows_written,
          rows_per_sec_write: snap.rows_per_sec_write,
          rows_per_sec_producer: snap.rows_per_sec_producer,
          phase: snap.phase,
        };
      } catch {
        snapshotFields = {
          rows_written: r.flushed_at_start != null ? 0 : 0,
          rows_per_sec_write: 0,
          rows_per_sec_producer: rps,
          phase: r.status === "error" ? "error" : r.status === "cancelled" ? "cancelled" : "producing",
        };
      }

      return { ...wireFields, rows_per_sec: rps, ...snapshotFields };
    },
  );

  app.get(
    "/ingest/bulk/load-status",
    { config: { category: "light" } },
    async (_req, reply) => {
      try {
        const fetchOne = createBulkLoaderStatusFetch({
          base: bulkBase,
          fetchImpl,
        });
        const topo = await discoverBulkLoaderTopology(fetchOne);
        const agg = await fetchAggregatedBulkLoadStatus(fetchOne, topo.replicas);
        reply.code(200);
        reply.header("content-type", "application/json");
        return agg;
      } catch (err) {
        reply.code(502);
        return { error: "bulk-loader unreachable", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  if (opts.getRedis) {
    registerIngestSnapshotRoute(app, {
      bulkBase,
      fetchImpl,
      getRedis: opts.getRedis,
      listRuns: getAllBulkRunRecords,
    });
  }
}

// Test-only inspector — used by ingest.test.ts to assert run tracking.
export function _testGetBulkRun(run_id: string): BulkRunRecord | undefined {
  return activeRuns.get(run_id);
}

export function _testResetBulkRuns(): void {
  activeRuns.clear();
}

function applyBulkRunCancel(record: BulkRunRecord): void {
  record.cancelled = true;
  record.status = "cancelled";
  if (record.cancelView) Atomics.store(record.cancelView, 0, 1);
  if (record.httpAbort && !record.httpAbort.signal.aborted) record.httpAbort.abort();
  if (record.workerHandles) {
    for (const w of record.workerHandles) void w.terminate();
  }
}

// Wave 7.0.8 — shared cancel surface for POST /ingest/bulk/cancel and
// POST /admin/stop-runs (mirrors generator.cancelAllActiveRuns).
export function cancelAllBulkRuns(): string[] {
  const run_ids: string[] = [];
  for (const entry of activeRuns.values()) {
    if (entry.status === "running" && !entry.cancelled) {
      applyBulkRunCancel(entry);
      run_ids.push(entry.run_id);
    }
  }
  if (run_ids.length > 0) void haltBulkLoaderAccept();
  return run_ids;
}

function archiveTerminalRun(
  record: BulkRunRecord,
  ctx: { bulkBase: string; fetchImpl: typeof fetch },
): void {
  const status = record.status;
  if (status === "running") return;
  void archiveBulkRunHistory(
    {
      run_id: record.run_id,
      status,
      rows_total: record.rows_total,
      rows_sent: record.rows_sent,
      rows_skipped: record.rows_skipped,
      batch_size: record.batch_size,
      concurrency: record.concurrency,
      workers: record.workers,
      started_at_iso: record.started_at_iso,
      ms: record.ms,
      bulk_loader_base: record.bulk_loader_base,
      flushed_at_start: record.flushed_at_start,
      ...(record.error ? { error: record.error } : {}),
    },
    ctx,
  ).catch(() => { /* best-effort */ });
}

// ---------------------------------------------------------------------------
// Wave 7.0.6.15 — run executors
// ---------------------------------------------------------------------------

interface InlineRunArgs {
  schema: Schema;
  body: BulkRunBody;
  rowsTotal: number;
  batchSize: number;
  concurrency: number;
  classes: string[];
  sensitivityTypes: string[];
  bulkBase: string;
  fetchImpl: typeof fetch;
  log: RouteLogger;
  record: BulkRunRecord;
  run_id: string;
}

// Inline single-thread path. Kept byte-for-byte equivalent to the pre-
// 7.0.6.15 loop (same generator init, same `for (i < rowsTotal)` order,
// same producer config) so the workers=1 canary holds. The only addition
// is the `record.cancelled` poll on the same 1024-row boundary the
// progress sampling already runs on — it cannot affect a completed (non-
// cancelled) run's output.
function runInline(args: InlineRunArgs): void {
  const { schema, body, rowsTotal, batchSize, concurrency, classes, sensitivityTypes,
    bulkBase, fetchImpl, log, record, run_id } = args;
  const coverageFloor = computeCoverageFloor(rowsTotal, 1);
  // Wave 7.0.6.20 — pre-plan per-class row counts (offset=0, stride=1 for
  // the inline single-thread loop below) so the reallocation-based coverage
  // floor sizes its quota table to EXACTLY this worker's row count.
  const plannedRowsByClass = coverageFloor > 0
    ? planRowsByClass(rowsTotal, classes, 0, 1)
    : undefined;
  const generator = createRowGenerator(schema, {
    seed: body.seed,
    sensitivityTypes,
    ...(body.trade_pool_size !== undefined ? { tradePoolSize: body.trade_pool_size } : {}),
    ...(body.factor_pool_size !== undefined ? { factorPoolSize: body.factor_pool_size } : {}),
    ...(coverageFloor > 0 ? { coverageFloor } : {}),
    ...(plannedRowsByClass ? { plannedRowsByClass } : {}),
  });
  // Wave 7.0.6.22 — cancel propagation into the HTTP producer's retry loop.
  // Without this an inline run with workers=1 that hits sustained 429s
  // never observes record.cancelled (the row-boundary poll runs only
  // BETWEEN rows, never inside producer.add()'s infinite-retry inner loop).
  const httpAbort = new AbortController();
  record.httpAbort = httpAbort;
  const producer = createHttpProducer({
    url: bulkBase,
    batchSize,
    maxInFlight: concurrency,
    fetchImpl,
    resumeFromCheckpoints: false,
    logger: log as unknown as never,
    signal: httpAbort.signal,
    onThrottleChange: (next) => { record.throttled = next; },
  });

  const t0 = process.hrtime.bigint();
  void (async () => {
    try {
      for (let i = 0; i < rowsTotal; i++) {
        const riskClass = classes[i % classes.length]!;
        const row = generator.generate(riskClass);
        await producer.add(row);
        if ((i & 0x3FF) === 0) {
          record.rows_sent = producer.rowsSent;
          record.rows_skipped = producer.rowsSkipped;
          record.retries_total = producer.retriesTotal;
          record.throttled_at_ms = producer.throttledAtMs;
          record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (record.cancelled) {
            if (!httpAbort.signal.aborted) httpAbort.abort();
            break;
          }
        }
      }
      await producer.close();
      record.rows_sent = producer.rowsSent;
      record.rows_skipped = producer.rowsSkipped;
      record.retries_total = producer.retriesTotal;
      record.throttled_at_ms = producer.throttledAtMs;
      record.throttled = producer.throttled;
      record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      record.status = record.cancelled ? "cancelled" : "done";
    } catch (err) {
      record.rows_sent = producer.rowsSent;
      record.rows_skipped = producer.rowsSkipped;
      record.retries_total = producer.retriesTotal;
      record.throttled_at_ms = producer.throttledAtMs;
      record.throttled = producer.throttled;
      record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      record.status = record.cancelled ? "cancelled" : "error";
      if (!record.cancelled) {
        record.error = err instanceof Error ? err.message : String(err);
        log.warn(
          { evt: "ingest-bulk-start", run_id, err: record.error },
          "bulk ingest producer aborted",
        );
      }
    } finally {
      archiveTerminalRun(record, { bulkBase, fetchImpl });
      setTimeout(() => activeRuns.delete(run_id), RUN_GRACE_MS).unref?.();
    }
  })();
}

interface WorkerRunArgs {
  schemaPath: string;
  body: BulkRunBody;
  rowsTotal: number;
  batchSize: number;
  concurrency: number;
  classes: string[];
  sensitivityTypes: string[];
  bulkBase: string;
  fetchImpl: typeof fetch;
  workers: number;
  log: RouteLogger;
  record: BulkRunRecord;
  run_id: string;
}

// Multi-worker path. Spawns N worker_threads, each owning 1/N of the row
// picker via stride partitioning (row `i` → worker `i % N`). Mirrors the
// CLI's `runWithWorkers` orchestration: aggregated progress is summed
// across per-worker latest snapshots; cancel is broadcast via a single
// SharedArrayBuffer Int32 polled inside each worker every 1024 rows.
function runWithWorkers(args: WorkerRunArgs): void {
  const { schemaPath, body, rowsTotal, batchSize, concurrency, classes, sensitivityTypes,
    bulkBase, fetchImpl, workers, log, record, run_id } = args;

  const cancelBuffer = new SharedArrayBuffer(4);
  const cancelView = new Int32Array(cancelBuffer);
  record.cancelView = cancelView;
  const perWorkerRows = new Int32Array(workers);
  const workerHandles: Worker[] = [];
  record.workerHandles = workerHandles;
  // Wave 7.0.6.22 — per-worker backpressure trackers. Aggregated into
  // record.{throttled,retries_total,throttled_at_ms} on every progress
  // frame so the UI's /ingest/bulk/runs/:id poll always sees an up-to-
  // date snapshot. `throttled` is an OR (any worker throttled ⇒ run
  // throttled); `retries_total` is a SUM; `throttled_at_ms` is the MAX.
  const perWorkerThrottled = new Array<boolean>(workers).fill(false);
  const perWorkerRetries = new Array<number>(workers).fill(0);
  const perWorkerThrottledAt = new Array<number | null>(workers).fill(null);
  record.perWorkerThrottled = perWorkerThrottled;
  record.perWorkerRetries = perWorkerRetries;
  record.perWorkerThrottledAt = perWorkerThrottledAt;
  record.throttled = false;
  record.retries_total = 0;
  record.throttled_at_ms = null;
  function recomputeBackpressure(): void {
    let anyThrottled = false;
    let retriesSum = 0;
    let lastAt: number | null = null;
    for (let i = 0; i < workers; i++) {
      if (perWorkerThrottled[i]) anyThrottled = true;
      retriesSum += perWorkerRetries[i] ?? 0;
      const at = perWorkerThrottledAt[i] ?? null;
      if (at !== null && (lastAt === null || at > lastAt)) lastAt = at;
    }
    record.throttled = anyThrottled;
    record.retries_total = retriesSum;
    record.throttled_at_ms = lastAt;
  }

  // Per-worker HTTP in-flight budget — divide the run's total concurrency
  // across workers (min 1) so the aggregate matches a workers=1 run.
  const perWorkerInFlight = Math.max(1, Math.floor(concurrency / workers));
  const baseSeed = body.seed !== undefined ? String(body.seed) : "default";
  // Wave 7.0.6.19 — per-worker coverage floor. The aggregate across stride
  // workers is ≥ the global floor because each worker forces ≥
  // ceil(globalFloor / workers) emissions per combo (helper rounds up).
  const perWorkerCoverageFloor = computeCoverageFloor(rowsTotal, workers);

  const t0 = process.hrtime.bigint();
  const workerPromises: Promise<void>[] = [];
  let firstError: Error | null = null;
  let totalRowsSent = 0;

  for (let w = 0; w < workers; w++) {
    // Wave 7.0.6.20 — per-worker planned row count per class. Each worker's
    // stride slice (`for i in [w, w+S, w+2S, ...) < N`) emits a deterministic
    // number of rows per class via `classes[i % C]` — computing it up-front
    // here lets the row-generator's reallocation path size its quotas to
    // EXACTLY this worker's row count (sum across workers == rowsTotal).
    const plannedRowsByClass = perWorkerCoverageFloor > 0
      ? planRowsByClass(rowsTotal, classes, w, workers)
      : undefined;
    const init: WorkerInitData = {
      schemaPath,
      // HTTP producer ignores these but the type requires them.
      redisUrl: "",
      stream: "",
      batchSize,
      pipelineWindow: 1,
      streamShards: 1,
      streamMaxLen: 0,
      seed: `${baseSeed}:w${w}`,
      totalRows: rowsTotal,
      workerIdx: w,
      totalWorkers: workers,
      classes,
      sensitivityTypes,
      ...(body.trade_pool_size !== undefined ? { tradePoolSize: body.trade_pool_size } : {}),
      ...(body.factor_pool_size !== undefined ? { factorPoolSize: body.factor_pool_size } : {}),
      ...(perWorkerCoverageFloor > 0 ? { coverageFloor: perWorkerCoverageFloor } : {}),
      ...(plannedRowsByClass ? { plannedRowsByClass } : {}),
      cancelBuffer,
      progressBatchSize: 1000,
      bulkLoadTarget: bulkBase,
      httpInFlight: perWorkerInFlight,
    };
    const worker = new Worker(workerEntryUrl, { workerData: init });
    workerHandles.push(worker);
    workerPromises.push(new Promise<void>((resolveP) => {
      worker.on("message", (msg: WorkerMessage) => {
        if (msg.type === "progress") {
          perWorkerRows[msg.workerIdx] = msg.rowsSent;
          let s = 0;
          for (let i = 0; i < workers; i++) s += perWorkerRows[i]!;
          if (s > record.rows_sent) record.rows_sent = s;
          record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (msg.throttled !== undefined) perWorkerThrottled[msg.workerIdx] = msg.throttled;
          if (typeof msg.retriesTotal === "number") perWorkerRetries[msg.workerIdx] = msg.retriesTotal;
          if (msg.throttledAtMs !== undefined) perWorkerThrottledAt[msg.workerIdx] = msg.throttledAtMs;
          recomputeBackpressure();
        } else if (msg.type === "done") {
          perWorkerRows[msg.workerIdx] = msg.rowsSent;
          totalRowsSent += msg.rowsSent;
          // Worker exited cleanly ⇒ no in-flight batches, no throttle.
          perWorkerThrottled[msg.workerIdx] = false;
          if (typeof msg.retriesTotal === "number") perWorkerRetries[msg.workerIdx] = msg.retriesTotal;
          if (msg.throttledAtMs !== undefined) perWorkerThrottledAt[msg.workerIdx] = msg.throttledAtMs;
          recomputeBackpressure();
        } else if (msg.type === "error") {
          if (!firstError) firstError = new Error(`worker ${msg.workerIdx}: ${msg.message}`);
          Atomics.store(cancelView, 0, 1);
        }
      });
      worker.on("error", (err) => {
        if (!firstError) firstError = err;
        Atomics.store(cancelView, 0, 1);
      });
      worker.on("exit", (code) => {
        if (code !== 0 && !firstError) {
          firstError = new Error(`worker ${w} exited with code ${code}`);
        }
        resolveP();
      });
    }));
  }

  void (async () => {
    try {
      await Promise.all(workerPromises);
      record.rows_sent = totalRowsSent;
      record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (firstError) {
        record.status = "error";
        record.error = (firstError as Error).message;
        log.warn(
          { evt: "ingest-bulk-start", run_id, err: record.error },
          "multi-worker bulk ingest aborted",
        );
      } else if (record.cancelled || Atomics.load(cancelView, 0) !== 0) {
        record.status = "cancelled";
      } else {
        record.status = "done";
      }
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      log.warn(
        { evt: "ingest-bulk-start", run_id, err: record.error },
        "multi-worker bulk ingest threw",
      );
    } finally {
      archiveTerminalRun(record, { bulkBase, fetchImpl });
      setTimeout(() => activeRuns.delete(run_id), RUN_GRACE_MS).unref?.();
    }
  })();
}


