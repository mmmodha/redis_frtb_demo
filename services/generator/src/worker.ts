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
import { createRowGenerator } from "./row-generator.ts";
import { createStreamProducer } from "./producer.ts";
import { runGenerationInline } from "./coordinator.ts";

export interface WorkerInitData {
  schemaPath: string;
  redisUrl: string;
  stream: string;
  batchSize: number;
  pipelineWindow: number;
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
  /** Optional Curvature/Delta/Vega mix is folded into sensitivityTypes by the
   * coordinator before spawn. */
  /** Int32Array view of [0] = cancel flag (0 = run, 1 = cancel). */
  cancelBuffer: SharedArrayBuffer;
  /** Coordinator-aggregated rate (rows/sec); each worker self-throttles to
   *  rate/totalWorkers locally so the aggregate matches. Optional. */
  rate?: number;
  /** Rows ADDed per postMessage progress frame. Default 1000. */
  progressBatchSize?: number;
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
  });
  const client = createClient(data.redisUrl);
  const producer = createStreamProducer(client, {
    stream: data.stream,
    batchSize: data.batchSize,
    pipelineWindow: data.pipelineWindow,
  });

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
    try { await client.quit(); } catch { /* connection already torn down */ }
  }
}

// Only auto-run when imported as a worker entry — leaves the module safely
// importable from tests (which exercise the inline coordinator helper).
if (parentPort) {
  void main();
}
