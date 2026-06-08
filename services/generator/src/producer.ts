import type { Redis, Cluster } from "ioredis";

export type SensitivityRow = {
  risk_class: string;
  bucket: string;
  _hash_tag: string;
  _id: string;
  [field: string]: unknown;
};

export interface StreamProducerOptions {
  stream: string;
  batchSize?: number;
  // Wave 5.84A — keep up to `pipelineWindow` pipeline.exec() calls in flight
  // at once. Default 1 is bit-identical to the pre-5.84A single-in-flight
  // behaviour; max 8 (the host TCP/redis-side sane upper bound for a single
  // producer connection).
  pipelineWindow?: number;
}

export const MAX_PIPELINE_WINDOW = 8;

export interface StreamProducer {
  add(row: SensitivityRow): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly rowsSent: number;
  readonly batchCount: number;
  readonly byClass: Record<string, number>;
}

type RedisLike = Redis | Cluster;

// Buffered XADD producer. Pipelines `batchSize` rows per flush — one
// network round-trip per batch. Per redis-development `conn-pipelining` and
// `pipeline-bulk-ops` skills, this is the throughput-critical path for the
// generator.
export function createStreamProducer(
  client: RedisLike,
  opts: StreamProducerOptions
): StreamProducer {
  const stream = opts.stream;
  const batchSize = Math.max(1, opts.batchSize ?? 1000);
  // Wave 5.84A — clamp pipeline window into [1, MAX_PIPELINE_WINDOW]. Default
  // 1 keeps today's "one pipeline in flight, awaited before next" semantics
  // bit-identical (proven by the stub-redis equivalence test).
  const pipelineWindow = Math.min(
    MAX_PIPELINE_WINDOW,
    Math.max(1, opts.pipelineWindow ?? 1),
  );
  const buffer: SensitivityRow[] = [];
  const stats = {
    rowsSent: 0,
    batchCount: 0,
    byClass: {} as Record<string, number>,
  };
  // Pipelines currently dispatched but not yet resolved. Bounded by
  // `pipelineWindow`; flush()/close() must drain this before returning.
  const inFlight = new Set<Promise<void>>();
  // First pipeline error observed across any in-flight dispatch — re-thrown
  // on the next dispatch/drain so a background rejection cannot silently
  // disappear when window>1 (the auto-removal in `finally` would otherwise
  // drop a rejected promise out of the set before drain could observe it).
  let firstError: unknown = null;

  async function dispatchBatch(): Promise<void> {
    if (firstError) throw firstError;
    if (buffer.length === 0) return;
    const batch = buffer.slice();
    buffer.length = 0;
    stats.batchCount += 1;
    const pipeline = client.pipeline();
    for (const row of batch) {
      const fields = serializeRow(row);
      pipeline.xadd(stream, "*", ...fields);
    }
    // Window=1 keeps the pre-5.84A flushBuffer code path exactly: dispatch
    // and immediately await this batch's exec before returning. This is the
    // bit-equivalence guarantee — same XADD sequence to Redis AND the same
    // per-batch macrotask yield timing (callers that depend on the await
    // landing per batch, like the api SSE cancel test, see no behavioural
    // change at window=1).
    if (pipelineWindow === 1) {
      const result = await pipeline.exec();
      if (result) {
        for (const [err] of result) {
          if (err) throw err;
        }
      }
      stats.rowsSent += batch.length;
      return;
    }
    // Window>1 — keep up to `pipelineWindow` pipeline.exec() calls in flight.
    let p!: Promise<void>;
    p = (async () => {
      try {
        const result = await pipeline.exec();
        if (result) {
          for (const [err] of result) {
            if (err) throw err;
          }
        }
        stats.rowsSent += batch.length;
      } catch (e) {
        if (!firstError) firstError = e;
        throw e;
      } finally {
        inFlight.delete(p);
      }
    })();
    inFlight.add(p);
    // Swallow unhandled-rejection here — the error is captured in firstError
    // and will be re-thrown on the next dispatch or drain call.
    p.catch(() => undefined);
    if (inFlight.size >= pipelineWindow) {
      await Promise.race([...inFlight]).catch(() => undefined);
      if (firstError) throw firstError;
    }
  }

  async function drainInFlight(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
    if (firstError) throw firstError;
  }

  return {
    async add(row: SensitivityRow): Promise<void> {
      buffer.push(row);
      stats.byClass[row.risk_class] = (stats.byClass[row.risk_class] ?? 0) + 1;
      if (buffer.length >= batchSize) {
        await dispatchBatch();
      }
    },
    async flush(): Promise<void> {
      await dispatchBatch();
      await drainInFlight();
    },
    async close(): Promise<void> {
      await dispatchBatch();
      await drainInFlight();
    },
    get rowsSent() {
      return stats.rowsSent;
    },
    get batchCount() {
      return stats.batchCount;
    },
    get byClass() {
      return stats.byClass;
    },
  };
}

// Serializes a row into XADD field-value pairs. Keeps `risk_class`, `bucket`,
// and `_hash_tag` at the top level so the consumer can route on hash-tag
// without parsing JSON; everything else goes into the `payload` JSON field
// (tenor arrays stay as native JSON for ingest → JSON.SET in Redis).
function serializeRow(row: SensitivityRow): string[] {
  const { risk_class, bucket, _hash_tag, _id, ...rest } = row;
  return [
    "risk_class",
    risk_class,
    "bucket",
    bucket,
    "_hash_tag",
    _hash_tag,
    "_id",
    _id,
    "payload",
    JSON.stringify(rest),
  ];
}
