import type { Redis, Cluster } from "ioredis";

// Stream consumer for the FRTB ingest service.
// Reads from Redis Stream `sensitivities:in` via XREADGROUP, builds the locked
// final key `sens:{risk_class:bucket}:{ulid}` (literal braces = hash-tag for
// slot-affinity per Wave 2 contract), writes the doc with JSON.SET, then XACKs.
// JSON.SET with the same key+doc is naturally idempotent: re-deliveries of the
// same logical row produce no duplicate keys.

export type RedisLike = Redis | Cluster;

export interface ConsumerOptions {
  stream: string;
  group: string;
  consumerName: string;
  batchSize?: number;
  blockMs?: number;
}

export interface ConsumerStats {
  consumed: number;
  acked: number;
  errors: number;
  batches: number;
}

export interface ConsumerRunner {
  start(): void;
  stop(): Promise<void>;
  readonly stats: ConsumerStats;
}

// Builds the locked final key shape `sens:{risk_class:bucket}:{ulid}`.
// The literal `{...}` braces around the hash-tag are required so Redis
// Cluster routes all sensitivities for the same (risk_class, bucket) to the
// same slot (per Wave 2 contract — keeps SBM FCALL slot-local).
export function buildKey(hashTag: string, id: string): string {
  return `sens:{${hashTag}}:${id}`;
}

// Reassembles the JSON doc from a Stream message. The generator stamps
// `risk_class`, `bucket`, `_hash_tag`, `_id`, and a JSON-stringified `payload`
// at the top level (see services/generator/src/producer.ts). The stored doc
// merges top-level routing fields with the parsed payload, dropping the
// transport-only meta fields (`_hash_tag`, `_id`, `payload`).
export function buildDoc(message: Record<string, string>): Record<string, unknown> {
  const { _hash_tag: _h, _id: _i, payload, risk_class, bucket, ...rest } = message;
  void _h; void _i;
  const parsed: Record<string, unknown> = payload ? JSON.parse(payload) : {};
  return { risk_class, bucket, ...rest, ...parsed };
}

// Creates the consumer group on the stream, MKSTREAM to handle the
// pre-publish case. Treats BUSYGROUP (group already exists) as success.
export async function ensureGroup(client: RedisLike, stream: string, group: string): Promise<void> {
  try {
    await client.xgroup("CREATE", stream, group, "$", "MKSTREAM");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("BUSYGROUP")) throw err;
  }
}

function fieldsToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i]!;
    const v = fields[i + 1]!;
    out[k] = v;
  }
  return out;
}

type XReadGroupReply = Array<[string, Array<[string, string[]]>]> | null;

// Single XREADGROUP batch: reads up to `batchSize` entries, writes each via
// JSON.SET and XACKs in one pipelined round-trip. `id` is either ">" (new
// entries) or "0" (pending entries previously delivered to this consumer name
// but not yet acked — used on restart to claim in-flight work).
export async function processBatch(
  client: RedisLike,
  opts: ConsumerOptions,
  id: ">" | "0" = ">",
  blockMs?: number
): Promise<number> {
  const count = Math.max(1, opts.batchSize ?? 500);
  const block = blockMs ?? opts.blockMs ?? 0;
  const reply = (await (client as Redis).xreadgroup(
    "GROUP", opts.group, opts.consumerName,
    "COUNT", count,
    "BLOCK", block,
    "STREAMS", opts.stream, id
  )) as XReadGroupReply;
  if (!reply) return 0;

  let processed = 0;
  for (const [, entries] of reply) {
    if (entries.length === 0) continue;
    const pipeline = client.pipeline();
    for (const [entryId, fields] of entries) {
      const msg = fieldsToMap(fields);
      const hashTag = msg._hash_tag ?? (msg.risk_class && msg.bucket ? `${msg.risk_class}:${msg.bucket}` : undefined);
      const ulid = msg._id;
      if (!hashTag || !ulid) {
        // Malformed entry — ack so it leaves the PEL but don't write a doc.
        pipeline.xack(opts.stream, opts.group, entryId);
        continue;
      }
      const key = buildKey(hashTag, ulid);
      const doc = buildDoc(msg);
      pipeline.call("JSON.SET", key, "$", JSON.stringify(doc));
      pipeline.xack(opts.stream, opts.group, entryId);
      processed++;
    }
    await pipeline.exec();
  }
  return processed;
}

// Long-running XREADGROUP loop. On start, drains any pending entries this
// consumer name was holding before exit, then blocks on new entries until
// stop() is called. Graceful shutdown waits for the in-flight batch to
// complete before resolving.
export function createConsumer(client: RedisLike, opts: ConsumerOptions): ConsumerRunner {
  const stats: ConsumerStats = { consumed: 0, acked: 0, errors: 0, batches: 0 };
  let stopped = false;
  let loopDone: Promise<void> | undefined;

  async function tick(id: ">" | "0", block: number): Promise<number> {
    try {
      const n = await processBatch(client, opts, id, block);
      if (n > 0) {
        stats.consumed += n;
        stats.acked += n;
        stats.batches += 1;
      }
      return n;
    } catch (err) {
      stats.errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("NOGROUP")) {
        await ensureGroup(client, opts.stream, opts.group);
      }
      return 0;
    }
  }

  async function loop(): Promise<void> {
    // claim-on-restart: replay anything previously delivered to this
    // consumer name but never XACKed (e.g. crashed mid-batch).
    while (!stopped) {
      const n = await tick("0", 0);
      if (n === 0) break;
    }
    while (!stopped) {
      await tick(">", opts.blockMs ?? 1000);
    }
  }

  return {
    start(): void {
      if (loopDone) return;
      loopDone = loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (loopDone) await loopDone;
    },
    get stats() { return stats; },
  };
}
