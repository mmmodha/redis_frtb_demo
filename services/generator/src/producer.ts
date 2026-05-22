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
}

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
  const buffer: SensitivityRow[] = [];
  const stats = {
    rowsSent: 0,
    batchCount: 0,
    byClass: {} as Record<string, number>,
  };

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0) return;
    const pipeline = client.pipeline();
    for (const row of buffer) {
      const fields = serializeRow(row);
      pipeline.xadd(stream, "*", ...fields);
    }
    const result = await pipeline.exec();
    if (result) {
      for (const [err] of result) {
        if (err) throw err;
      }
    }
    stats.rowsSent += buffer.length;
    stats.batchCount += 1;
    buffer.length = 0;
  }

  return {
    async add(row: SensitivityRow): Promise<void> {
      buffer.push(row);
      stats.byClass[row.risk_class] = (stats.byClass[row.risk_class] ?? 0) + 1;
      if (buffer.length >= batchSize) {
        await flushBuffer();
      }
    },
    async flush(): Promise<void> {
      await flushBuffer();
    },
    async close(): Promise<void> {
      await flushBuffer();
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
