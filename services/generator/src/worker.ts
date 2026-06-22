// Wave 5.84B — worker_threads entry point. One worker owns one ioredis client
// + one RowGenerator + one StreamProducer, and writes the rows whose global
// index i satisfies `i % totalWorkers === workerIdx` (the picker stride that
// keeps the global class mix identical to single-thread — DoD #2).
//
// ioredis is NOT safe to share across threads, so each worker holds its own
// connection (cleanup via `client.quit()` in the finally block — DoD #6).
//
// Per-worker seed is `${base}:w${workerIdx}` for the main RNG; the row
// generator naturally derives `${base}:w${workerIdx}:aux` for the aux RNG
// (preserves the Wave 5.17a tenant-field isolation).
//
// Cancel + stop-on conditions are broadcast via a SharedArrayBuffer Int32.
// `Atomics.load(flag, 0) !== 0` ⇒ cancel. Polled every N rows in the loop.
//
// Progress is reported back to the coordinator via `parentPort.postMessage`
// — the coordinator merges per-worker counts into a single monotonic SSE
// stream (DoD #5).

import { parentPort, workerData } from "node:worker_threads";
import type { Redis, Cluster } from "ioredis";
import { Cluster as ClusterCtor } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema } from "@frtb/schema";
import pino from "pino";
import { createRowGenerator } from "./row-generator.ts";
import { createStreamProducer, type StreamProducer } from "./producer.ts";
import { runGenerationInline } from "./coordinator.ts";
import { createStreamRouter, type StreamShardsConfig } from "@frtb/stream-router";
import { createStreamFlowControl } from "./flow-control.ts";
// Wave 6.39.A — direct-write path. Lazy-bound via dynamic import so the
// generator's tsconfig rootDir contract (./src) stays intact while the
// writer reuses services/ingest/src/consumer.ts at runtime.
import { createDirectWriter, type StorageFormat } from "./direct-writer.ts";
import { loadDirectWriterHooks, resolveStorageFormatEnv } from "./direct-writer-bind.ts";
// Wave 7.0.1.C — bulk-loader HTTP producer wired in via `bulkLoadTarget`.
import { createHttpProducer } from "./http-producer.ts";

export interface WorkerInitData {
  schemaPath: string;
  redisUrl: string;
  stream: string;
  batchSize: number;
  pipelineWindow: number;
  // Wave 5.92A — hash-tag stream-shard config. Each worker constructs its
  // own router locally so the producer fans XADDs across N stream keys
  // (modulo-N or per-bucket). Default 1 keeps the pre-5.92 single-stream
  // path bit-identical. Threaded through `workerData` because routers
  // aren't serialisable across worker_threads.postMessage boundaries.
  streamShards: StreamShardsConfig;
  // Wave 5.92C — approximate XADD MAXLEN cap. 0 means opt out.
  streamMaxLen: number;
  /** Per-worker seed already includes the `:w${idx}` suffix; the row-generator
   * appends `:aux` for the aux RNG so isolation is preserved. */
  seed: string;
  totalRows: number;
  workerIdx: number;
  totalWorkers: number;
  classes: string[];
  sensitivityTypes?: string[];
  tradePoolSize?: number;
  factorPoolSize?: number;
  /** Wave 7.0.6.19 — per-worker sensitivity_type coverage floor. Coordinator
   *  divides the global floor (max(1, floor(rowsTotal/100))) by totalWorkers
   *  before spawn so the aggregate guarantee holds. Undefined / 0 disables. */
  coverageFloor?: number;
  /** Optional Curvature/Delta/Vega mix is folded into sensitivityTypes by the
   * coordinator before spawn. */
  /** Int32Array view of [0] = cancel flag (0 = run, 1 = cancel). */
  cancelBuffer: SharedArrayBuffer;
  /** Coordinator-aggregated rate (rows/sec); each worker self-throttles to
   *  rate/totalWorkers locally so the aggregate matches. Optional. */
  rate?: number;
  /** Rows ADDed per postMessage progress frame. Default 1000. */
  progressBatchSize?: number;
  /** Wave 6.39.A — generator backend. `stream` (default) keeps the legacy
   *  XADD path bit-identical; `direct` swaps the producer for the
   *  direct-write writer (HSET + pre-aggregated HINCRBYFLOAT + SADD). */
  mode?: "stream" | "direct";
  /** Wave 6.39.A — bucket sampling mode. Undefined preserves the legacy
   *  schema-aware draw (rng-isolation canary holds). */
  distribution?: "uniform" | "realistic" | "pareto";
  /** Wave 6.39.A — STORAGE_FORMAT override for direct-write. Ignored in
   *  stream mode (ingest resolves its own STORAGE_FORMAT). */
  storageFormat?: StorageFormat;
  /** Wave 7.0.1.C — bulk-loader HTTP target URL. When set, swaps in the
   *  HTTP producer (POST /load/rows) instead of XADD/direct. Mutually
   *  exclusive with `mode === "direct"` (validated at the CLI). */
  bulkLoadTarget?: string;
  /** Wave 7.0.1.C — per-worker max concurrent in-flight POSTs to
   *  /load/rows. Defaults to 64 if undefined (matches CLI fallback). */
  httpInFlight?: number;
}

export type WorkerMessage =
  | { type: "progress"; workerIdx: number; rowsSent: number }
  | {
      type: "done";
      workerIdx: number;
      rowsSent: number;
      byClass: Record<string, number>;
      cancelled: boolean;
    }
  | { type: "error"; workerIdx: number; message: string };

function createClient(url: string): Redis | Cluster {
  if (url.startsWith("redis-cluster://")) {
    const stripped = url.replace("redis-cluster://", "redis://");
    return new ClusterCtor([stripped]);
  }
  return createRedisClient({ url });
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error("worker.ts must be run as a worker_thread");
  const data = workerData as WorkerInitData;
  const cancel = new Int32Array(data.cancelBuffer);

  const schema = loadSchema(data.schemaPath);
  const generator = createRowGenerator(schema, {
    seed: data.seed,
    sensitivityTypes: data.sensitivityTypes,
    tradePoolSize: data.tradePoolSize,
    factorPoolSize: data.factorPoolSize,
    distribution: data.distribution,
    coverageFloor: data.coverageFloor,
  });
  // Wave 7.0.1.C — HTTP producer needs no Redis connection; skip the
  // createClient call entirely so per-worker connection budget is zero.
  let client: Redis | Cluster | undefined;
  // Wave 5.92C — per-worker pino logger (worker_threads can't share the
  // parent's pino instance).
  const log = pino({ level: process.env.LOG_LEVEL ?? "info" }).child({ worker: data.workerIdx });
  // Wave 6.39.A — mode-aware writer construction. `stream` keeps the
  // pre-6.39.A producer path bit-identical; `direct` swaps in the direct-
  // write writer (HSET + pre-aggregated HINCRBYFLOAT + SADD) and bypasses
  // the stream entirely (router + flow-control gate are stream-only).
  // Wave 7.0.1.C — `bulkLoadTarget` takes precedence over both stream and
  // direct (CLI rejects bulk + direct combo before spawn).
  let producer: StreamProducer;
  if (data.bulkLoadTarget) {
    producer = createHttpProducer({
      url: data.bulkLoadTarget,
      batchSize: data.batchSize,
      maxInFlight: data.httpInFlight,
      logger: log,
    }) as unknown as StreamProducer;
  } else if (data.mode === "direct") {
    client = createClient(data.redisUrl);
    const hooks = await loadDirectWriterHooks();
    producer = createDirectWriter(client, {
      schema,
      storageFormat: data.storageFormat ?? "hash-sidetable",
      batchSize: data.batchSize,
      hooks,
    }) as unknown as StreamProducer;
  } else {
    client = createClient(data.redisUrl);
    const router = createStreamRouter(data.stream, data.streamShards);
    const flowControl = createStreamFlowControl(client, {}, log);
    producer = createStreamProducer(client, {
      stream: data.stream,
      batchSize: data.batchSize,
      pipelineWindow: data.pipelineWindow,
      router,
      streamMaxLen: data.streamMaxLen > 0 ? data.streamMaxLen : undefined,
      flowControl,
    });
  }

  const progressEvery = data.progressBatchSize ?? 1000;
  const port = parentPort;

  try {
    const result = await runGenerationInline({
      totalRows: data.totalRows,
      classes: data.classes,
      offset: data.workerIdx,
      stride: data.totalWorkers,
      generator,
      producer,
      isCancelled: () => Atomics.load(cancel, 0) !== 0,
      rate: data.rate,
      onProgress: (rowsSent) =>
        port.postMessage({ type: "progress", workerIdx: data.workerIdx, rowsSent } satisfies WorkerMessage),
      progressEvery,
    });
    // Wave 7.0.1.C — HTTP producer's flush() (called by runGenerationInline)
    // empties the row buffer, but only close() releases queued waiters and
    // surfaces background POST errors. close() is a no-op for the stream /
    // direct paths when buffers are already empty.
    if (data.bulkLoadTarget) await producer.close();
    port.postMessage({
      type: "done",
      workerIdx: data.workerIdx,
      rowsSent: result.rowsSent,
      byClass: result.byClass,
      cancelled: result.cancelled,
    } satisfies WorkerMessage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({
      type: "error",
      workerIdx: data.workerIdx,
      message,
    } satisfies WorkerMessage);
  } finally {
    if (client) {
      try { await client.quit(); } catch { /* connection already torn down */ }
    }
  }
}

// Only auto-run when imported as a worker entry — leaves the module safely
// importable from tests (which exercise the inline coordinator helper).
if (parentPort) {
  void main();
}
