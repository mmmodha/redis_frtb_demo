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

import { ulid } from "ulid";
import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import { createRowGenerator, createHttpProducer } from "@frtb/generator";

export interface IngestRoutesOpts {
  // Override bulk-loader base URL. Falls back to BULK_LOADER_URL env, then
  // to BULK_LOADER_PORT (compose-internal default 8086).
  bulkLoaderBase?: string;
  // Test seam — defaults to global fetch.
  fetchImpl?: typeof fetch;
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
}

interface BulkRunRecord {
  run_id: string;
  status: "running" | "done" | "error";
  rows_total: number;
  rows_sent: number;
  rows_skipped: number;
  batch_size: number;
  concurrency: number;
  started_at_iso: string;
  ms: number;
  bulk_loader_base: string;
  error?: string;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 32;
const MAX_BATCH_SIZE = 10_000;
const MAX_CONCURRENCY = 256;
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
        started_at_iso,
        ms: 0,
        bulk_loader_base: bulkBase,
      };
      activeRuns.set(run_id, record);

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
        // Disable resume on UI-driven runs so 100k-row demos deliver
        // exactly `rowsTotal` regardless of prior checkpoints.
        resumeFromCheckpoints: false,
        logger: app.log,
      });

      const t0 = process.hrtime.bigint();
      void (async () => {
        try {
          for (let i = 0; i < rowsTotal; i++) {
            const riskClass = classes[i % classes.length]!;
            const row = generator.generate(riskClass);
            await producer.add(row);
            // Sample producer state into the tracked record so /runs/:id
            // reflects progress without an extra counter on this hot loop.
            if ((i & 0x3FF) === 0) {
              record.rows_sent = producer.rowsSent;
              record.rows_skipped = producer.rowsSkipped;
              record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
            }
          }
          await producer.close();
          record.rows_sent = producer.rowsSent;
          record.rows_skipped = producer.rowsSkipped;
          record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
          record.status = "done";
        } catch (err) {
          record.rows_sent = producer.rowsSent;
          record.rows_skipped = producer.rowsSkipped;
          record.ms = Number(process.hrtime.bigint() - t0) / 1e6;
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          app.log.warn(
            { evt: "ingest-bulk-start", run_id, err: record.error },
            "bulk ingest producer aborted",
          );
        } finally {
          setTimeout(() => activeRuns.delete(run_id), RUN_GRACE_MS).unref?.();
        }
      })();

      reply.code(202);
      return {
        ok: true,
        run_id,
        rows_total: rowsTotal,
        batch_size: batchSize,
        concurrency,
        bulk_loader_base: bulkBase,
        started_at_iso,
      };
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
      return { ...r, rows_per_sec: rps };
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
