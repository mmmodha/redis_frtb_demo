// Wave 7.0.1.C — bulk-loader HTTP row sink.
//
// Drop-in alternative to `StreamProducer`: same `add/flush/close` surface
// (+ `rowsSent`/`batchCount`/`byClass`) so the shared row-loop in
// `runGenerationInline` drives it unchanged. Instead of XADD-ing to a
// Redis Stream, this producer POSTs row batches to the bulk-loader's
// `/load/rows` endpoint over HTTP. The bulk-loader's dispatcher (7.0.1.B)
// owns slim HSET serialisation + per-shard backpressure; the generator's
// only job is to keep enough rows in flight to saturate it.
//
// Backpressure (folded from Wave 7.0.5.B):
//   • Total concurrent in-flight POSTs are capped at `maxInFlight`
//     (GENERATOR_INFLIGHT, default 64). `add()` awaits when saturated.
//   • HTTP 429 from /load/rows triggers exponential-with-jitter backoff
//     of `min(50 × 2^attempt, 1000)` ms before retry. After 5 consecutive
//     429s on the same batch the producer emits a slow-shard warning log
//     line (does NOT crash) and keeps retrying.
//   • HTTP 5xx (transient) follows the same retry path. Non-2xx, non-429,
//     non-5xx responses (e.g. 400 malformed) throw immediately.
//
// Per-process metrics surface (DoD: rows emitted, 429-throttle events,
// current in-flight count) — `rowsSent`, `throttle429`, `inFlight`.

import type { SensitivityRow } from "./row-generator.ts";

export interface HttpProducerOptions {
  /** Base URL of the bulk-loader (e.g. `http://localhost:8086`). */
  url: string;
  /** Rows per POST body. Defaults to 500 — small enough that a 429 from
   *  one batch does not undo a large slice of work, large enough that
   *  per-request overhead stays << dispatcher write time. */
  batchSize?: number;
  /** Max concurrent in-flight POSTs. Defaults to 64 (GENERATOR_INFLIGHT). */
  maxInFlight?: number;
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Sleep override (tests). Defaults to setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter override (tests). Defaults to `Math.random()`. Must return a
   *  value in [0, 1). */
  random?: () => number;
  /** Optional structured logger (matches pino's child-logger shape). */
  logger?: {
    warn?: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

export interface HttpProducer {
  add(row: SensitivityRow): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly rowsSent: number;
  readonly batchCount: number;
  readonly byClass: Record<string, number>;
  /** Wave 7.0.1.C — count of 429 responses observed across all batches. */
  readonly throttle429: number;
  /** Current concurrent in-flight POST count. */
  readonly inFlight: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_IN_FLIGHT = 64;
const MAX_BACKOFF_MS = 1000;
const BASE_BACKOFF_MS = 50;
const SLOW_SHARD_WARN_AFTER = 5;

// Generator emits rows with two synthetic prefixed fields (`_id`, `_hash_tag`)
// — the bulk-loader's Row contract expects `id`, no `_hash_tag`. Strip both
// here so the network payload is the slim shape the dispatcher consumes.
export function toBulkRow(row: SensitivityRow): Record<string, unknown> {
  const { _id, _hash_tag: _drop, ...rest } = row as SensitivityRow & { _hash_tag?: unknown };
  void _drop;
  return { id: _id, ...rest };
}

export function createHttpProducer(opts: HttpProducerOptions): HttpProducer {
  if (!opts.url || typeof opts.url !== "string") {
    throw new Error("createHttpProducer: url is required");
  }
  const endpoint = opts.url.replace(/\/+$/, "") + "/load/rows";
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxInFlight = Math.max(1, opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  if (!fetchImpl) {
    throw new Error("createHttpProducer: global fetch unavailable; pass fetchImpl");
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const log = opts.logger;

  const buffer: SensitivityRow[] = [];
  const stats = { rowsSent: 0, batchCount: 0, throttle429: 0, inFlight: 0 };
  const byClass: Record<string, number> = {};
  const inFlightSet = new Set<Promise<void>>();
  const waiters: Array<() => void> = [];
  let firstError: unknown = null;
  let closed = false;

  // Slot accounting (Wave 7.0.1.C). `inFlight` is incremented *synchronously*
  // either on `acquireSlot()` (when a slot is free) or by `releaseOneWaiter()`
  // (which reserves the freed slot for the next queued waiter atomically).
  // Decrement happens in `dispatch()`'s IIFE `finally`. Reserving on release
  // prevents the producer-callsite race where N concurrent `add()` calls all
  // observe `inFlight=0` before any of them increments — without it the
  // maxInFlight cap is only enforced for serial callers.
  function releaseOneWaiter(): void {
    const w = waiters.shift();
    if (w) {
      stats.inFlight += 1;
      w();
    }
  }

  async function acquireSlot(): Promise<void> {
    if (stats.inFlight < maxInFlight) {
      stats.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function backoffMs(attempt: number): number {
    const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
    // Full-jitter: random in [0, exp]. Keeps the worst-case bound at
    // MAX_BACKOFF_MS while preventing the synchronized-retry stampede a
    // pure exponential schedule would create across N parallel workers.
    return Math.floor(random() * (exp + 1));
  }

  async function postBatch(batch: SensitivityRow[]): Promise<void> {
    const payload = JSON.stringify(batch.map(toBulkRow));
    let attempt = 0;
    let consec429 = 0;
    while (true) {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
      } catch (err) {
        // Network-level failure — treat like a transient 5xx and back off.
        await sleep(backoffMs(attempt));
        attempt++;
        if (attempt > SLOW_SHARD_WARN_AFTER) {
          log?.warn?.(
            { evt: "bulk-load-network-retry", url: endpoint, attempt, err: String(err) },
            "bulk-loader POST network failure; backing off",
          );
        }
        continue;
      }
      if (res.status === 202) {
        // Bodies are small JSON acks; consume and discard so the connection
        // can be reused. Failure to drain doesn't poison the run.
        await res.text().catch(() => undefined);
        stats.rowsSent += batch.length;
        return;
      }
      if (res.status === 429) {
        stats.throttle429++;
        consec429++;
        await res.text().catch(() => undefined);
        if (consec429 === SLOW_SHARD_WARN_AFTER) {
          // Single warn per slow-shard episode. Subsequent 429s within the
          // same retry loop do not re-log — operators care that throughput
          // is pinned, not about every individual retry.
          log?.warn?.(
            { evt: "bulk-load-slow-shard", url: endpoint, consec429, batch_size: batch.length },
            `bulk-loader returned 429 ${consec429}× consecutive — slow shard suspected`,
          );
        }
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        await res.text().catch(() => undefined);
        await sleep(backoffMs(attempt));
        attempt++;
        if (attempt > SLOW_SHARD_WARN_AFTER) {
          log?.warn?.(
            { evt: "bulk-load-5xx-retry", url: endpoint, status: res.status, attempt },
            "bulk-loader returned 5xx; backing off",
          );
        }
        continue;
      }
      // 4xx other than 429 (e.g. 400 malformed, 503 not-accepting) — these
      // are operator-fixable misconfigurations. Surface the body so the
      // generator log explains why ingest stopped.
      const body = await res.text().catch(() => "");
      throw new Error(`bulk-loader ${res.status} ${endpoint}: ${body.slice(0, 256)}`);
    }
  }

  // `dispatch` runs AFTER acquireSlot() has reserved an in-flight slot, so
  // it does NOT bump `stats.inFlight` itself. The slot is released in the
  // IIFE's `finally`, either by re-using it for a queued waiter (atomic
  // hand-off in `releaseOneWaiter`) or by simply decrementing back to free.
  function dispatch(batch: SensitivityRow[]): void {
    stats.batchCount += 1;
    let p!: Promise<void>;
    p = (async () => {
      try {
        await postBatch(batch);
      } catch (e) {
        if (!firstError) firstError = e;
      } finally {
        inFlightSet.delete(p);
        // Hand the freed slot to a queued waiter if any; otherwise drop the
        // counter. Without the conditional `releaseOneWaiter` would bump
        // inFlight back up when there's no waiter to consume it.
        if (waiters.length > 0) {
          releaseOneWaiter();
        } else {
          stats.inFlight -= 1;
        }
      }
    })();
    inFlightSet.add(p);
    // Background rejection captured via firstError above; suppress the
    // unhandled-rejection so node doesn't crash the process.
    p.catch(() => undefined);
  }

  return {
    async add(row: SensitivityRow): Promise<void> {
      if (closed) throw new Error("http-producer: add after close");
      if (firstError) throw firstError;
      buffer.push(row);
      byClass[row.risk_class] = (byClass[row.risk_class] ?? 0) + 1;
      if (buffer.length >= batchSize) {
        const batch = buffer.splice(0, batchSize);
        await acquireSlot();
        if (firstError) throw firstError;
        dispatch(batch);
      }
    },
    async flush(): Promise<void> {
      if (buffer.length > 0) {
        const batch = buffer.splice(0, buffer.length);
        await acquireSlot();
        if (firstError) throw firstError;
        dispatch(batch);
      }
      while (inFlightSet.size > 0) {
        await Promise.allSettled([...inFlightSet]);
      }
      if (firstError) throw firstError;
    },
    async close(): Promise<void> {
      await this.flush();
      closed = true;
      // Release any stranded waiters from add() so callers that raced our
      // close() don't leak — they'll see "add after close" on next call.
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w();
      }
    },
    get rowsSent() { return stats.rowsSent; },
    get batchCount() { return stats.batchCount; },
    get byClass() { return byClass; },
    get throttle429() { return stats.throttle429; },
    get inFlight() { return stats.inFlight; },
  };
}
