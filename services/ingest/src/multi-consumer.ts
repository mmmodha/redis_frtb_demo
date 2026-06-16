// Wave 5.92B — multi-shard consumer driver.
//
// Spawns one `createConsumer()` runner per assigned stream-shard.
// Wave 6.15b — each runner now owns its own ioredis client (constructed via
// `makeRunnerClient`) so XREADGROUP fetches and pipeline.exec writes run on
// independent sockets instead of serialising through one shared activeClient.
// The shared `client` arg is still accepted for cold-path lookups (group
// setup happens via `ensureGroupsForShards` before spawn) but the hot path
// uses the per-handle client only.
//
// Aggregated `stats` sum across runners so /healthz and the throughput log
// keep their existing single-counter contract. `start()` / `stop()` fan out
// over the per-shard runners; `stop()` also closes each runner-local client
// with `quit()` and a 2s timeout fallback to `disconnect()`.

import type { Schema } from "@frtb/schema";
import {
  createConsumer,
  ensureGroup,
  type ConsumerRunner,
  type ConsumerStats,
  type RedisLike,
} from "./consumer.ts";
import { shardStreamKey } from "./sharding.ts";
import { PROFILE_ENABLED, createRunnerProfile, type RunnerProfile } from "./profile.ts";

export interface ShardConsumerHandle {
  shard: number;
  stream: string;
  consumerName: string;
  runner: ConsumerRunner;
  // Wave 6.15b — dedicated ioredis client for this shard's hot path
  // (XREADGROUP / pipeline.exec / XACK). Constructed via `makeRunnerClient`
  // at spawn time; closed by multi.stop().
  client: RedisLike;
  // Wave 6.15a — populated only when INGEST_PROFILE=1; null otherwise so the
  // multi-consumer's start/stop fan-out can no-op cheaply in production.
  profile: RunnerProfile | null;
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
  // Wave 6.15b — factory invoked once per shard runner at spawn time. Must
  // return a fresh client whose option shape matches the shared activeClient
  // (TLS, password, cluster vs standalone, lazyConnect, retries, etc.).
  makeRunnerClient: () => RedisLike;
  // Wave 6.15b — graceful shutdown budget per runner client. quit() is
  // attempted first; if it doesn't resolve within this window we fall back
  // to disconnect(). Defaults to 2000ms; tests override to keep runs fast.
  runnerQuitTimeoutMs?: number;
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

// Wave 6.15b — close a runner-local ioredis client gracefully. Prefers
// `quit()` (drains in-flight commands and sends QUIT) and falls back to
// `disconnect()` if quit hasn't resolved within `timeoutMs`. Mirrors the
// shutdown shape used in services/generator/src/cli.ts (probeClient.quit
// in a finally with disconnect as the hard backstop).
async function closeRunnerClient(client: RedisLike, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const quit = (client as { quit: () => Promise<unknown> }).quit().then(
    () => "ok" as const,
    () => "ok" as const,
  );
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([quit, timeout]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    try { (client as { disconnect: () => void }).disconnect(); } catch { /* ignore */ }
  }
}

export function createMultiShardConsumer(
  client: RedisLike,
  opts: MultiConsumerOptions,
): MultiConsumer {
  // Wave 6.15b — `client` is the shared activeClient kept for cold-path
  // operations (group setup ran via ensureGroupsForShards before spawn,
  // target watcher subscribe, profile-emit logging). Hot-path ops use the
  // per-runner client constructed via opts.makeRunnerClient.
  void client;
  const quitTimeoutMs = opts.runnerQuitTimeoutMs ?? 2000;
  // Per-shard consumer name only carries the `-s<n>` suffix in multi-shard
  // mode so single-shard CONSUMER_NAME stays byte-identical to pre-5.92.
  const handles: ShardConsumerHandle[] = opts.assignment.map((shard) => {
    const stream = shardStreamKey(opts.baseStream, shard, opts.totalShards);
    const consumerName = opts.totalShards <= 1
      ? opts.consumerNameBase
      : `${opts.consumerNameBase}-s${shard}`;
    // Wave 6.15a — one profiler per shard runner, labelled with the
    // shard index. Only constructed when INGEST_PROFILE=1.
    const profile = PROFILE_ENABLED ? createRunnerProfile(`s${shard}`) : null;
    // Wave 6.15b — own ioredis client per runner so XREADGROUP/pipeline.exec
    // can run concurrently across shards instead of queueing on one socket.
    const runnerClient = opts.makeRunnerClient();
    const runner = createConsumer(runnerClient, {
      stream,
      group: opts.group,
      consumerName,
      batchSize: opts.batchSize,
      blockMs: opts.blockMs,
      schema: opts.schema,
      profile: profile ?? undefined,
    });
    return { shard, stream, consumerName, runner, client: runnerClient, profile };
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
      for (const h of handles) {
        h.profile?.start();
        h.runner.start();
      }
    },
    // Drain every shard's in-flight XREADGROUP batch in parallel so the
    // active-target swap window is bounded by max(blockMs), not sum(blockMs).
    async stop(): Promise<void> {
      await Promise.all(handles.map((h) => h.runner.stop()));
      // Wave 6.15a — emit a consolidated lifetime summary per shard once
      // the runner has fully drained, then stop the 5s reporter timer.
      for (const h of handles) {
        if (h.profile) {
          h.profile.emitFinalSummary();
          h.profile.stop();
        }
      }
      // Wave 6.15b — close each runner-local ioredis client. quit() drains
      // QUIT through any in-flight pipeline; if it doesn't resolve within
      // the configured budget we fall back to disconnect() so a misbehaving
      // socket can't hold rebuild() open indefinitely.
      await Promise.all(handles.map((h) => closeRunnerClient(h.client, quitTimeoutMs)));
    },
  };
}
