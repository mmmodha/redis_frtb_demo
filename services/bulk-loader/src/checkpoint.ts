// Wave 7.0.5.A — per-worker checkpoint persistence for crash-resume.
//
// Each bulk-loader worker maintains a high-water mark (`lastUlid`) of the
// most-recently flushed `sens:<ulid>` row. This module periodically persists
// `(rows_written, last_ulid, last_updated)` into a Redis HASH keyed
// `bulk:checkpoint:<worker_id>` — NO `{...}` hash tag, mirroring the
// slim-write key-shape rule so the proxy's all-master-shards policy spreads
// checkpoints across master nodes the same way it spreads `sens:*`.
//
// On bootstrap, `loadAll()` reads back every known worker's checkpoint via
// HGETALL (iterating 0..N-1 — no SCAN, no KEYS) so the bulk-loader can
// surface the resume watermark to a freshly-spawned generator via the
// `/load/checkpoints` HTTP endpoint.

export interface CheckpointClient {
  call(command: string, ...args: unknown[]): Promise<unknown>;
}

export interface CheckpointRecord {
  rows_written: number;
  last_ulid: string | null;
  last_updated: number;
}

export interface CheckpointSourceEntry {
  id: number;
  flushed: number;
  lastUlid: string | null;
}

export interface CheckpointSource {
  workers(): readonly CheckpointSourceEntry[];
}

export interface CheckpointerOptions {
  client: CheckpointClient;
  source: CheckpointSource;
  intervalMs?: number;
  now?: () => number;
  keyPrefix?: string;
  logger?: {
    warn?: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

export interface Checkpointer {
  start(): void;
  stop(): Promise<void>;
  /** Flush a single round of checkpoints synchronously (test hook + boot/shutdown). */
  flushOnce(): Promise<void>;
  /** Bootstrap: read back persisted checkpoints for `count` workers (ids 0..count-1). */
  loadAll(count: number): Promise<Map<number, CheckpointRecord>>;
}

export const DEFAULT_CHECKPOINT_INTERVAL_MS = 30_000;
export const DEFAULT_CHECKPOINT_KEY_PREFIX = "bulk:checkpoint:";

export function createCheckpointer(opts: CheckpointerOptions): Checkpointer {
  const intervalMs = opts.intervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `createCheckpointer: intervalMs must be a positive number (got ${String(intervalMs)})`,
    );
  }
  const now = opts.now ?? Date.now;
  const keyPrefix = opts.keyPrefix ?? DEFAULT_CHECKPOINT_KEY_PREFIX;
  const log = opts.logger;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let pending: Promise<void> | null = null;

  async function flushOnce(): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      const entries = opts.source.workers();
      const ts = now();
      for (const w of entries) {
        // HSET is idempotent so a re-flush of an unchanged worker is safe.
        // Persist `last_ulid` as the empty string when null — Redis HASHes
        // can't hold a "null" sentinel, and loadAll() coerces "" back to
        // null so the contract round-trips cleanly.
        try {
          await opts.client.call(
            "HSET",
            `${keyPrefix}${w.id}`,
            "rows_written",
            String(w.flushed),
            "last_ulid",
            w.lastUlid ?? "",
            "last_updated",
            String(ts),
          );
        } catch (err) {
          // Best-effort: a single failing HSET shouldn't poison the round
          // (other workers still get persisted) and shouldn't crash the
          // bulk-loader. Operators see this in the warn log.
          log?.warn?.(
            { worker_id: w.id, key: `${keyPrefix}${w.id}`, err: String(err) },
            "checkpoint HSET failed",
          );
        }
      }
    })();
    try {
      await pending;
    } finally {
      pending = null;
    }
  }

  function tick(): void {
    if (stopped) return;
    void flushOnce().finally(() => {
      if (stopped) return;
      const t = setTimeout(tick, intervalMs);
      if (typeof t.unref === "function") t.unref();
      timer = t;
    });
  }

  function start(): void {
    if (timer || stopped) return;
    const t = setTimeout(tick, intervalMs);
    if (typeof t.unref === "function") t.unref();
    timer = t;
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    // Final flush so a graceful shutdown captures the freshest state.
    try {
      await flushOnce();
    } catch (err) {
      log?.warn?.({ err: String(err) }, "checkpoint final flush failed");
    }
  }

  async function loadAll(count: number): Promise<Map<number, CheckpointRecord>> {
    const out = new Map<number, CheckpointRecord>();
    if (!Number.isInteger(count) || count < 1) return out;
    for (let id = 0; id < count; id++) {
      try {
        const raw = (await opts.client.call("HGETALL", `${keyPrefix}${id}`)) as unknown;
        const rec = parseHgetallReply(raw);
        if (rec) out.set(id, rec);
      } catch (err) {
        log?.warn?.(
          { worker_id: id, key: `${keyPrefix}${id}`, err: String(err) },
          "checkpoint HGETALL failed",
        );
      }
    }
    return out;
  }

  return { start, stop, flushOnce, loadAll };
}

// ioredis returns HGETALL as a flat string[] (k,v,k,v) for raw-call. Some
// fakes/clients return an object map instead. Accept both shapes; return
// null when the key is unset (empty reply).
export function parseHgetallReply(raw: unknown): CheckpointRecord | null {
  const map = new Map<string, string>();
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      map.set(String(raw[i]), String(raw[i + 1]));
    }
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return null;
    for (const k of keys) map.set(k, String(obj[k]));
  } else {
    return null;
  }
  const rowsRaw = map.get("rows_written");
  const ulidRaw = map.get("last_ulid");
  const tsRaw = map.get("last_updated");
  if (rowsRaw === undefined && ulidRaw === undefined && tsRaw === undefined) {
    return null;
  }
  const rows = Number(rowsRaw ?? 0);
  const ts = Number(tsRaw ?? 0);
  return {
    rows_written: Number.isFinite(rows) ? rows : 0,
    last_ulid: ulidRaw && ulidRaw.length > 0 ? ulidRaw : null,
    last_updated: Number.isFinite(ts) ? ts : 0,
  };
}
