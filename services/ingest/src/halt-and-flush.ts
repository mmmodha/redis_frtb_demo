// Wave 6.44.E — destructive halt-and-flush primitive.
//
// Called from POST /ingest/halt-and-flush after the consumer loop has been
// drained (mutex held inside shardRuntime.haltAndFlush). XTRIMs every shard
// input stream to MAXLEN 0 and SCAN+UNLINKs every `sens:*` key per master
// node so the search index drops back to empty. Idempotent: running against
// already-empty streams / no docs is a no-op that returns zero counters.
//
// Only touches `sensitivities:in[:{N}]` streams and `sens:*` doc keys. Config
// keys, schema-hash sentinels, runtime function libraries, and the rollup
// hash family are left untouched — see scope note in the 6.44.E task.

import type { RedisLike } from "./consumer.ts";
import { shardStreamKey } from "./sharding.ts";

// Mirrors resolveMasterNodes in backfill-rollups.ts: ioredis Cluster exposes
// .nodes("master") whereas a standalone Redis does not. Returning the bare
// client for standalone keeps the call shape uniform.
function resolveMasterNodes(client: RedisLike): RedisLike[] {
  const maybe = client as { nodes?: (role: string) => RedisLike[] };
  if (typeof maybe.nodes === "function") return maybe.nodes("master");
  return [client];
}

export interface HaltAndFlushReport {
  streams_trimmed: number;
  docs_cleared: number;
}

export interface HaltAndFlushOptions {
  // Override the per-node SCAN COUNT hint. Default 5000 matches the task
  // scope note ("SCAN MATCH sens:* COUNT 5000") and keeps each iteration
  // bounded so a large adopted corpus doesn't monopolise the loop.
  scanCount?: number;
  // Override the UNLINK batch size. UNLINK is variadic but very large argv
  // lists can exceed cluster proxy buffers; 500 mirrors backfill-rollups's
  // SCAN_COUNT default and is well under any practical limit.
  unlinkBatchSize?: number;
  // Match pattern for the doc-clearing SCAN. Defaults to "sens:*". Exposed
  // for tests that need to assert the SCAN argument.
  docMatch?: string;
}

const DEFAULT_SCAN_COUNT = 5000;
const DEFAULT_UNLINK_BATCH = 500;
const DEFAULT_DOC_MATCH = "sens:*";

// XTRIM each shard stream to MAXLEN 0. STREAM_SHARDS=1 (the legacy default)
// produces the single bare-key stream; STREAM_SHARDS>1 produces the
// hash-tagged shard keys via shardStreamKey. We always trim the FULL
// configured shard set — even shards this replica is not assigned — so a
// halt-and-flush is destructive across the whole cluster's input backlog.
async function trimShardStreams(
  client: RedisLike,
  baseStream: string,
  totalShards: number,
): Promise<number> {
  let trimmed = 0;
  for (let s = 0; s < totalShards; s++) {
    const key = shardStreamKey(baseStream, s, totalShards);
    try {
      await client.call("XTRIM", key, "MAXLEN", "0");
      trimmed++;
    } catch {
      // A missing stream is the common cold-start case; XTRIM on a non-
      // existent key is a no-op in Redis but some test stubs throw. Either
      // way the post-condition (xlen=0) holds, so swallow and continue.
      trimmed++;
    }
  }
  return trimmed;
}

// Per-master SCAN+UNLINK loop. UNLINK is preferred over DEL so the deletion
// happens off the main thread on large key sets — matters when an adopted
// 1M-doc corpus is being wiped.
async function clearSensDocs(
  client: RedisLike,
  match: string,
  scanCount: number,
  unlinkBatchSize: number,
): Promise<number> {
  let cleared = 0;
  const nodes = resolveMasterNodes(client);
  for (const node of nodes) {
    let cursor = "0";
    do {
      const reply = (await node.call(
        "SCAN", cursor, "MATCH", match, "COUNT", String(scanCount),
      )) as unknown;
      if (
        !Array.isArray(reply) || reply.length < 2 ||
        typeof reply[0] !== "string" || !Array.isArray(reply[1])
      ) {
        break;
      }
      cursor = reply[0];
      const keys = reply[1] as string[];
      for (let i = 0; i < keys.length; i += unlinkBatchSize) {
        const batch = keys.slice(i, i + unlinkBatchSize);
        if (batch.length === 0) continue;
        try {
          await node.call("UNLINK", ...batch);
          cleared += batch.length;
        } catch {
          // UNLINK can fail on a cluster slot mismatch when SCAN returned
          // keys across slots; fall back to per-key UNLINK so a single bad
          // slot doesn't lose the whole batch.
          for (const k of batch) {
            try { await node.call("UNLINK", k); cleared++; } catch { /* skip */ }
          }
        }
      }
    } while (cursor !== "0");
  }
  return cleared;
}

export async function performHaltAndFlush(
  client: RedisLike,
  baseStream: string,
  totalShards: number,
  opts: HaltAndFlushOptions = {},
): Promise<HaltAndFlushReport> {
  const scanCount = opts.scanCount ?? DEFAULT_SCAN_COUNT;
  const unlinkBatchSize = opts.unlinkBatchSize ?? DEFAULT_UNLINK_BATCH;
  const docMatch = opts.docMatch ?? DEFAULT_DOC_MATCH;
  const streams_trimmed = await trimShardStreams(client, baseStream, totalShards);
  const docs_cleared = await clearSensDocs(client, docMatch, scanCount, unlinkBatchSize);
  return { streams_trimmed, docs_cleared };
}
