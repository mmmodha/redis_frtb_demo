import type { Redis, Cluster } from "ioredis";
import type { StreamRouter } from "@frtb/stream-router";

export type SensitivityRow = {
  risk_class: string;
  bucket: string;
  _hash_tag: string;
  _id: string;
  [field: string]: unknown;
};

export interface StreamProducerFlowControl {
  afterBatch(streamKey: string, batchSize: number): Promise<void>;
}

export interface StreamProducerOptions {
  stream: string;
  batchSize?: number;
  // Wave 5.84A — keep up to `pipelineWindow` pipeline.exec() calls in flight
  // at once. Default 1 is bit-identical to the pre-5.84A single-in-flight
  // behaviour; max 8 (the host TCP/redis-side sane upper bound for a single
  // producer connection).
  pipelineWindow?: number;
  // Wave 5.92A — optional hash-tag → stream-key router. When omitted (or when
  // the router's `shardCount === 1`), the producer runs the legacy single-
  // buffer code path verbatim, preserving the pre-5.92 XADD command sequence
  // (bit-equivalence canary in workers.test.ts). When N>1 (or per-bucket),
  // the producer maintains one in-memory buffer per resolved stream key;
  // pipelineWindow is the GLOBAL cap across all in-flight pipeline.exec()
  // calls, not per-stream.
  router?: StreamRouter;
  // Wave 5.92C — when set, every XADD includes `MAXLEN ~ <streamMaxLen>` so
  // Redis approximately caps the stream length and protects holding shards
  // from OOM when consumers fall behind. Default undefined keeps the XADD
  // command sequence bit-identical to pre-5.92C (the canary tests rely on
  // the undefined default). The generator CLI / source ingest layer set
  // this from the `--stream-maxlen` flag / `STREAM_MAXLEN` env (default
  // 2_000_000).
  streamMaxLen?: number;
  // Wave 5.92C — optional producer-side credit gate. After each successful
  // XADD batch the producer calls `flowControl.afterBatch(streamKey, n)`;
  // the gate may sleep when XLEN exceeds a threshold so the producer pauses
  // generation until consumers drain.
  flowControl?: StreamProducerFlowControl;
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
  // Wave 5.92A — per-stream buffers. With no router (or N=1), every row
  // resolves to the base `stream` key so the Map collapses to a single
  // entry and the XADD command sequence is bit-identical to pre-5.92. With
  // N>1 (or per-bucket), each distinct routed stream key gets its own
  // buffer; pipelineWindow remains a GLOBAL cap across all in-flight
  // dispatches (not per-stream).
  const router = opts.router;
  // Wave 5.92C — pre-compute the optional MAXLEN ~ N arg-prefix once so the
  // hot loop is a spread, not a per-row branch. Undefined streamMaxLen
  // collapses to an empty array, preserving the pre-5.92C XADD command
  // sequence (canary in workers.test.ts).
  const maxLenArgs: readonly string[] = opts.streamMaxLen !== undefined
    ? ["MAXLEN", "~", String(opts.streamMaxLen)]
    : [];
  const flowControl = opts.flowControl;
  const buffers = new Map<string, SensitivityRow[]>();
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

  function bufferFor(streamKey: string): SensitivityRow[] {
    let b = buffers.get(streamKey);
    if (!b) {
      b = [];
      buffers.set(streamKey, b);
    }
    return b;
  }

  async function dispatchBatch(streamKey: string): Promise<void> {
    if (firstError) throw firstError;
    const buffer = buffers.get(streamKey);
    if (!buffer || buffer.length === 0) return;
    const batch = buffer.slice();
    buffer.length = 0;
    stats.batchCount += 1;
    const pipeline = client.pipeline();
    for (const row of batch) {
      const fields = serializeRow(row);
      // Wave 5.92C — `MAXLEN ~ N` (if configured) goes between the stream
      // key and the id placeholder so the producer's command sequence is
      // a clean `XADD <key> [MAXLEN ~ <N>] * <fields...>`.
      pipeline.xadd(streamKey, ...maxLenArgs, "*", ...fields);
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
      // Wave 5.92C — credit gate runs AFTER the dispatch lands so the
      // post-batch XLEN reflects this batch's writes. Awaiting here serializes
      // the next dispatchBatch behind any pause loop (producer-side pause).
      if (flowControl) await flowControl.afterBatch(streamKey, batch.length);
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
        if (flowControl) await flowControl.afterBatch(streamKey, batch.length);
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

  // Wave 5.92A — resolve the target stream key for a row. With no router,
  // every row goes to the base `stream` (single-buffer collapse, byte-for-
  // byte equal to the pre-5.92 XADD sequence — guarded by the canary test
  // in workers.test.ts). With a router, the row's `_hash_tag` is FNV-1a
  // hashed and routed to one of the N pre-enumerated stream keys.
  const routeRow = router
    ? (row: SensitivityRow): string => router.route(row._hash_tag)
    : (_row: SensitivityRow): string => stream;

  return {
    async add(row: SensitivityRow): Promise<void> {
      const streamKey = routeRow(row);
      const buffer = bufferFor(streamKey);
      buffer.push(row);
      stats.byClass[row.risk_class] = (stats.byClass[row.risk_class] ?? 0) + 1;
      if (buffer.length >= batchSize) {
        await dispatchBatch(streamKey);
      }
    },
    async flush(): Promise<void> {
      // Snapshot keys before dispatching — dispatch may clear buffer entries
      // but the Map keys persist so we iterate exactly the streams we know
      // had rows queued at flush time.
      for (const streamKey of [...buffers.keys()]) {
        await dispatchBatch(streamKey);
      }
      await drainInFlight();
    },
    async close(): Promise<void> {
      for (const streamKey of [...buffers.keys()]) {
        await dispatchBatch(streamKey);
      }
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
