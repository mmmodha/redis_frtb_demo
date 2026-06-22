// Wave 6.39.C — Layer 4: hourly rollup snapshot job.
//
// SCAN the active DB for `rollup:*` keys, copy each via HGETALL + HMSET to
// `snap:rollup:<ts>:<original-key>`, EXPIRE the destination at 7 days. The
// per-run summary lands in the `snap:index` hash (one field per run keyed
// by ISO timestamp) so /admin/snapshots can render the history without
// re-scanning. Wave 7.0.6.6 — rollup keys are tag-free so the snapshot
// destination is also tag-free; cluster-mode slot affinity is no longer
// guaranteed but HGETALL + HMSET on different slots is still safe (two
// independent commands, no MULTI).

import type { RedisLike } from "../redis-like.ts";
import { incCounter } from "./metrics.ts";

const SNAPSHOT_TTL_SEC = 7 * 24 * 3600;
const SNAPSHOT_INDEX_KEY = "snap:index";
const ROLLUP_PREFIX = "rollup:";

export interface RunSnapshotOpts {
  redis: RedisLike;
  // ISO-8601 timestamp the snapshot is tagged with. Production passes
  // `new Date().toISOString()`; tests supply a fixture so assertions stay
  // deterministic.
  ts: string;
}

export interface SnapshotSummary {
  ts: string;
  key_count: number;
}

// Parse RESP2 flat or RESP3 map HGETALL replies. Empty/missing → null so
// the caller can skip the destination HMSET entirely (HMSET with no
// fields is a syntax error).
function parseHgetall(reply: unknown): Record<string, string> | null {
  if (reply === null || reply === undefined) return null;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < reply.length; i += 2) {
      out[String(reply[i])] = String(reply[i + 1]);
    }
    return out;
  }
  if (typeof reply === "object") {
    const src = reply as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) out[k] = String(v);
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

// Iterate every `rollup:*` key via SCAN + MATCH so a snapshot run sees a
// consistent (best-effort) view without blocking the server. COUNT 1000 is
// the same hint observability/keys uses — large enough that 100k buckets
// finish in O(100) SCAN cursors.
async function* scanRollupKeys(redis: RedisLike): AsyncGenerator<string> {
  let cursor: string = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${ROLLUP_PREFIX}*`, "COUNT", 1000);
    cursor = String(next);
    for (const k of keys) yield k;
  } while (cursor !== "0");
}

export async function runSnapshot(opts: RunSnapshotOpts): Promise<SnapshotSummary> {
  const { redis, ts } = opts;
  incCounter("snapshot_total");
  let keyCount = 0;
  for await (const key of scanRollupKeys(redis)) {
    const hash = parseHgetall(await redis.call("HGETALL", key));
    if (!hash) continue;
    // Strip the `rollup:` prefix so the snapshot lives at
    // `snap:rollup:<ts>:<rc>:<bkt>:<sens>[:tenor:<t>]` (Wave 7.0.6.6 —
    // tag-free; mirrors the live rollup shape).
    const suffix = key.startsWith(ROLLUP_PREFIX) ? key.slice(ROLLUP_PREFIX.length) : key;
    const dst = `snap:rollup:${ts}:${suffix}`;
    const fieldArgs: string[] = [];
    for (const [k, v] of Object.entries(hash)) {
      fieldArgs.push(k, v);
    }
    await redis.call("HMSET", dst, ...fieldArgs);
    await redis.call("EXPIRE", dst, SNAPSHOT_TTL_SEC);
    keyCount += 1;
  }
  // Index this run so listSnapshots can enumerate without re-scanning. Use
  // HSET (not HMSET) — the snap:index hash is global and lives on whatever
  // slot the no-tag key hashes to.
  await redis.call("HSET", SNAPSHOT_INDEX_KEY, ts, String(keyCount));
  return { ts, key_count: keyCount };
}

// Read the snap:index hash and return one entry per prior run, sorted
// newest-first by ISO timestamp. Used by GET /admin/snapshots.
export async function listSnapshots(redis: RedisLike): Promise<SnapshotSummary[]> {
  const reply = await redis.call("HGETALL", SNAPSHOT_INDEX_KEY);
  const parsed = parseHgetall(reply);
  if (!parsed) return [];
  const out: SnapshotSummary[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    out.push({ ts: k, key_count: Number(v) });
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return out;
}

export interface StartSnapshotCronOpts {
  redis: RedisLike;
  intervalMs: number;
  log?: { error: (obj: Record<string, unknown>) => void };
}

export function startSnapshotCron(opts: StartSnapshotCronOpts): () => void {
  const tick = async (): Promise<void> => {
    try {
      await runSnapshot({ redis: opts.redis, ts: new Date().toISOString() });
    } catch (err) {
      opts.log?.error?.({ event: "snapshot_tick_failed", err: String(err) });
    }
  };
  const handle = setInterval(() => { void tick(); }, opts.intervalMs);
  return () => clearInterval(handle);
}
