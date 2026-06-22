// Wave 7.0.6.13 — bulk-loader ingest fast path.
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
  // Wave 7.0.6.15 — co-located cancel surface. SAB for workers>1 (workers
  // poll Atomics.load(cancelView, 0)); `cancelled` flag for inline.
  cancelView?: Int32Array;
  cancelled?: boolean;
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
const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega"] as const;
// Bulk-loader-only retention; the UI polls /ingest/bulk/runs/:id while a run
// is in flight and a few seconds after completion, then drops the handle.
const RUN_GRACE_MS = 60_000;

const activeRuns = new Map<string, BulkRunRecord>();

function pickInt(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) {
    if (v !== undefined && Number.isFinite(v)) return v;
  }
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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

  app.post<{ Body: BulkRunBody }>(
    "/ingest/bulk/start",
    { config: { category: "heavy-ingest" } },
    async (req, reply) => {
      if (!schema) {
        reply.code(503);
        return { ok: false, error: "schema not loaded" };
      }
      const body = (req.body ?? {}) as BulkRunBody;
      const rowsTotal = pickInt(body.rowsTotal, body.rows);
      if (rowsTotal === undefined || !Number.isInteger(rowsTotal) || rowsTotal < 1) {
        reply.code(400);
        return { ok: false, error: "rows must be a positive integer" };
      }
      const batchSize = clamp(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
      const concurrency = clamp(body.concurrency ?? DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
      // Wave 7.0.6.15 — host-aware worker cap. The UI exposes a slider that
      // /admin/host-info pre-fills with cores-2; the route still clamps so
      // a hand-rolled curl can't oversubscribe the host.
      const requestedWorkers = pickInt(body.workers) ?? 1;
      const hostCores = Math.max(1, availableCores());
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
        bulk_loader_base: bulkBase,
      };
      activeRuns.set(run_id, record);

      // Wave 7.0.6.15 — workers=1 stays on the inline path so the
      // single-worker bit-equivalence canary holds (CLI mirrors this skip).
      if (workers === 1) {
        runInline({
          schema,
          body,
          rowsTotal,
          batchSize,
          concurrency,
          classes,
          sensitivityTypes,
          bulkBase,
          fetchImpl,
          log: app.log,
          record,
          run_id,
        });
      } else {
        if (!schemaPath) {
          reply.code(503);
          activeRuns.delete(run_id);
          return { ok: false, error: "schemaPath not resolvable for multi-worker run" };
        }
        runWithWorkers({
          schemaPath,
          body,
          rowsTotal,
          batchSize,
          concurrency,
          classes,
          sensitivityTypes,
          bulkBase,
          workers,
          log: app.log,
          record,
          run_id,
        });
      }

      reply.code(202);
      return {
        ok: true,
        run_id,
        rows_total: rowsTotal,
        batch_size: batchSize,
        concurrency,
        workers,
        bulk_loader_base: bulkBase,
        started_at_iso,
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
      r.cancelled = true;
      if (r.cancelView) Atomics.store(r.cancelView, 0, 1);
      return { ok: true, run_id, status: r.status };
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
      const rps = r.ms > 0 ? Math.round((r.rows_sent * 1000) / r.ms) : 0;
      // Strip non-serialisable fields (Int32Array view over SAB) before
      // shipping over the wire. Spread preserves every other key so the UI
      // and existing tests see no shape change.
      const { cancelView: _cv, ...wireFields } = r;
      void _cv;
      return { ...wireFields, rows_per_sec: rps };
    },
  );

  app.get(
    "/ingest/bulk/load-status",
    { config: { category: "light" } },
    async (_req, reply) => {
      try {
        const res = await fetchImpl(`${bulkBase}/load/status`, { method: "GET" });
        const text = await res.text();
        reply.code(res.status);
        reply.header("content-type", res.headers.get("content-type") ?? "application/json");
        return text;
      } catch (err) {
        reply.code(502);
        return { error: "bulk-loader unreachable", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

// Test-only inspector — used by ingest.test.ts to assert run tracking.
export function _testGetBulkRun(run_id: string): BulkRunRecord | undefined {
  return activeRuns.get(run_id);
}

export function _testResetBulkRuns(): void {
  activeRuns.clear();
}

// ---------------------------------------------------------------------------
// Wave 7.0.6.15 — run executors
// ---------------------------------------------------------------------------

// Logger surface narrow enough that both fastify's pino instance and the
// console satisfy it without an explicit dependency on pino.
interface RouteLogger {
  warn: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

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
  const generator = createRowGenerator(schema, {
    seed: body.seed,
    sensitivityTypes,
    ...(body.trade_pool_size !== undefined ? { tradePoolSize: body.trade_pool_size } : {}),
    ...(body.factor_pool_size !== undefined ? { factorPoolSize: body.factor_pool_size } : {}),
  });
  const producer = createHttpProducer({
    url: bulkBase,
    batchSize,
    maxInFlight: concurrency,
    fetchImpl,
    resumeFromCheckpoints: false,
    logger: log as unknown as never,
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
          record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (record.cancelled) break;
        }
      }
      await producer.close();
      record.rows_sent = producer.rowsSent;
      record.rows_skipped = producer.rowsSkipped;
      record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      record.status = record.cancelled ? "cancelled" : "done";
    } catch (err) {
      record.rows_sent = producer.rowsSent;
      record.rows_skipped = producer.rowsSkipped;
      record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      log.warn(
        { evt: "ingest-bulk-start", run_id, err: record.error },
        "bulk ingest producer aborted",
      );
    } finally {
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
    bulkBase, workers, log, record, run_id } = args;

  const cancelBuffer = new SharedArrayBuffer(4);
  const cancelView = new Int32Array(cancelBuffer);
  record.cancelView = cancelView;
  const perWorkerRows = new Int32Array(workers);

  // Per-worker HTTP in-flight budget — divide the run's total concurrency
  // across workers (min 1) so the aggregate matches a workers=1 run.
  const perWorkerInFlight = Math.max(1, Math.floor(concurrency / workers));
  const baseSeed = body.seed !== undefined ? String(body.seed) : "default";

  const t0 = process.hrtime.bigint();
  const workerPromises: Promise<void>[] = [];
  let firstError: Error | null = null;
  let totalRowsSent = 0;

  for (let w = 0; w < workers; w++) {
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
      cancelBuffer,
      progressBatchSize: 1000,
      bulkLoadTarget: bulkBase,
      httpInFlight: perWorkerInFlight,
    };
    const worker = new Worker(workerEntryUrl, { workerData: init });
    workerPromises.push(new Promise<void>((resolveP) => {
      worker.on("message", (msg: WorkerMessage) => {
        if (msg.type === "progress") {
          perWorkerRows[msg.workerIdx] = msg.rowsSent;
          let s = 0;
          for (let i = 0; i < workers; i++) s += perWorkerRows[i]!;
          if (s > record.rows_sent) record.rows_sent = s;
          record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
        } else if (msg.type === "done") {
          perWorkerRows[msg.workerIdx] = msg.rowsSent;
          totalRowsSent += msg.rowsSent;
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
      setTimeout(() => activeRuns.delete(run_id), RUN_GRACE_MS).unref?.();
    }
  })();
}


