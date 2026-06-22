// Wave 7.0.1.B — shared input queue with round-robin worker dispatch.
//
// The dispatcher owns N write workers (one per pool connection) and exposes
// `enqueue(row)` as the producer-facing entry point. Each worker buffers rows
// and flushes batched HSETs to `sens:<ulid>` via its dedicated ioredis socket;
// the dispatcher does NOT do client-side slot routing — OSS Cluster API is
// not enabled, ULIDs are CRC16-uniform across slots, and the Enterprise
// proxy's `all-master-shards` policy spreads the pooled connections across
// master nodes. Workers are picked round-robin.
//
// Backpressure: total in-flight rows (queued in any worker + currently-being
// flushed) is bounded by `highWater`. When the bound is hit, `enqueue` returns
// a Promise that only resolves once enough rows have settled (committed OR
// dead-lettered) to drop in-flight below the limit. Wave 7.0.1.C's producer
// awaits this Promise to pause its emit loop.

import {
  createWorker,
  type Row,
  type WorkerClient,
  type WorkerHandle,
  type WorkerMetrics,
} from "./worker.ts";

export type { Row, WorkerClient, WorkerMetrics } from "./worker.ts";

export interface DispatcherOptions {
  workerClients: WorkerClient[];
  batchSize: number;
  idleFlushMs: number;
  // Defaults to 5 × batchSize × workerClients.length per task brief.
  highWater?: number;
  maxRetries?: number;
  deadLetterStream?: string;
  deadLetterMaxLen?: number;
  now?: () => number;
  logger?: {
    warn?: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

export interface DispatcherStatus {
  inFlight: number;
  highWater: number;
  workers: WorkerMetrics[];
}

export interface DispatcherHandle {
  enqueue(row: Row): Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
  status(): DispatcherStatus;
  // Exposed for tests + 7.0.1.C wiring — read-only access to the underlying
  // write workers. Callers MUST NOT mutate the buffers directly; use enqueue.
  readonly workers: readonly WorkerHandle[];
}

export function createDispatcher(opts: DispatcherOptions): DispatcherHandle {
  if (!Array.isArray(opts.workerClients) || opts.workerClients.length < 1) {
    throw new Error("createDispatcher: workerClients must be a non-empty array");
  }
  const batchSize = opts.batchSize;
  const idleFlushMs = opts.idleFlushMs;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("createDispatcher: batchSize must be a positive integer");
  }
  const highWater = opts.highWater ?? 5 * batchSize * opts.workerClients.length;
  if (!Number.isInteger(highWater) || highWater < 1) {
    throw new Error("createDispatcher: highWater must be a positive integer");
  }

  let inFlight = 0;
  const waiters: Array<() => void> = [];

  function settle(n: number): void {
    inFlight -= n;
    if (inFlight < 0) inFlight = 0;
    while (waiters.length > 0 && inFlight < highWater) {
      const w = waiters.shift();
      if (w) w();
    }
  }

  const workers: WorkerHandle[] = opts.workerClients.map((client, i) =>
    createWorker({
      id: i,
      client,
      batchSize,
      idleFlushMs,
      maxRetries: opts.maxRetries,
      deadLetterStream: opts.deadLetterStream,
      deadLetterMaxLen: opts.deadLetterMaxLen,
      onSettle: settle,
      now: opts.now,
      logger: opts.logger,
    }),
  );

  let nextWorker = 0;
  function pickWorker(): WorkerHandle {
    const w = workers[nextWorker];
    nextWorker = (nextWorker + 1) % workers.length;
    // workers[] is non-empty (guarded above) so this is always defined.
    return w as WorkerHandle;
  }

  async function enqueue(row: Row): Promise<void> {
    // Block while at or above the high-water mark. Waiters are FIFO so
    // producers are released in arrival order as rows settle.
    while (inFlight >= highWater) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inFlight++;
    pickWorker().push(row);
  }

  async function drain(): Promise<void> {
    await Promise.all(workers.map((w) => w.drain()));
  }

  async function stop(): Promise<void> {
    await drain();
    await Promise.all(workers.map((w) => w.stop()));
    // Release any stranded waiters so callers awaiting enqueue() during a
    // shutdown unblock instead of leaking.
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w();
    }
  }

  function status(): DispatcherStatus {
    return {
      inFlight,
      highWater,
      workers: workers.map((w) => w.metrics()),
    };
  }

  return { enqueue, drain, stop, status, workers };
}
