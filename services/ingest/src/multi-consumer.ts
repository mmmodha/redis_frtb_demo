// Wave 5.92B — multi-shard consumer driver.
//
// Spawns one `createConsumer()` runner per assigned stream-shard against a
// single shared ioredis client. Aggregated `stats` sum across runners so the
// /healthz endpoint and throughput log keep their existing single-counter
// contract. `start()` / `stop()` fan out over the per-shard runners.

import type { Schema } from "@frtb/schema";
import {
  createConsumer,
  ensureGroup,
  type ConsumerRunner,
  type ConsumerStats,
  type RedisLike,
} from "./consumer.ts";
import { shardStreamKey } from "./sharding.ts";

export interface ShardConsumerHandle {
  shard: number;
  stream: string;
  consumerName: string;
  runner: ConsumerRunner;
}

export interface MultiConsumerOptions {
  baseStream: string;
  group: string;
  consumerNameBase: string;
  totalShards: number;
  assignment: readonly number[];
  batchSize?: number;
  blockMs?: number;
  schema?: Schema;
}

export interface MultiConsumer {
  start(): void;
  stop(): Promise<void>;
  readonly handles: readonly ShardConsumerHandle[];
  readonly stats: ConsumerStats;
}

// Calls XGROUP CREATE … MKSTREAM once per shard stream, sequentially. Each
// stream gets its own group copy; the group name is shared across shards so
// downstream operators (`XINFO GROUPS`, monitoring) see a single logical
// consumer-group identity across the sharded fan-out.
export async function ensureGroupsForShards(
  client: RedisLike,
  streams: readonly string[],
  group: string,
): Promise<void> {
  for (const stream of streams) {
    await ensureGroup(client, stream, group);
  }
}

export function createMultiShardConsumer(
  client: RedisLike,
  opts: MultiConsumerOptions,
): MultiConsumer {
  // Per-shard consumer name only carries the `-s<n>` suffix in multi-shard
  // mode so single-shard CONSUMER_NAME stays byte-identical to pre-5.92.
  const handles: ShardConsumerHandle[] = opts.assignment.map((shard) => {
    const stream = shardStreamKey(opts.baseStream, shard, opts.totalShards);
    const consumerName = opts.totalShards <= 1
      ? opts.consumerNameBase
      : `${opts.consumerNameBase}-s${shard}`;
    const runner = createConsumer(client, {
      stream,
      group: opts.group,
      consumerName,
      batchSize: opts.batchSize,
      blockMs: opts.blockMs,
      schema: opts.schema,
    });
    return { shard, stream, consumerName, runner };
  });

  // Aggregated stats expose live sums via getters so /healthz and the
  // throughput log read a single roll-up across every per-shard runner.
  const stats: ConsumerStats = {
    get consumed() {
      let n = 0;
      for (const h of handles) n += h.runner.stats.consumed;
      return n;
    },
    get acked() {
      let n = 0;
      for (const h of handles) n += h.runner.stats.acked;
      return n;
    },
    get errors() {
      let n = 0;
      for (const h of handles) n += h.runner.stats.errors;
      return n;
    },
    get batches() {
      let n = 0;
      for (const h of handles) n += h.runner.stats.batches;
      return n;
    },
  };

  return {
    handles,
    stats,
    start(): void {
      for (const h of handles) h.runner.start();
    },
    // Drain every shard's in-flight XREADGROUP batch in parallel so the
    // active-target swap window is bounded by max(blockMs), not sum(blockMs).
    async stop(): Promise<void> {
      await Promise.all(handles.map((h) => h.runner.stop()));
    },
  };
}
