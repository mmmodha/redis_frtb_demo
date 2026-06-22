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
// Backpressure (Wave 7.0.6.22 — infinite retry, no give-up):
//   • Total concurrent in-flight POSTs are capped at `maxInFlight`
//     (GENERATOR_INFLIGHT, default 64). `add()` awaits when saturated.
//   • HTTP 429 / 5xx / network failures trigger adaptive backoff with
//     full jitter (`min(100 × 2^attempt, 5000)` ms) and the batch is
//     retried INDEFINITELY — no max-attempts cap. Row loss on
//     backpressure (the pre-7.0.6.22 give-up after 50 retries) is gone.
//   • On the first 429 in a batch the producer flips a worker-local
//     `throttled` flag and fires `onThrottleChange(true)`; on the next
//     2xx the flag clears and `onThrottleChange(false)` fires. Callers
//     surface this to the UI's rate-gauge to explain why throughput is
//     pinned.
//   • Cancellation is via `signal?: AbortSignal`. When aborted, in-flight
//     fetches receive the signal, pending backoff sleeps wake early, and
//     the producer's `firstError` is set so subsequent add/flush/close
//     surface the abort. The Stop button MUST set this signal — without
//     it a worker stuck in the infinite-retry loop will never observe a
//     coordinator-level cancel flag (which is only polled at row
//     boundaries inside runGenerationInline, never between retries).
//
// Per-process metrics surface — `rowsSent`, `throttle429`, `inFlight`,
// `throttled`, `retriesTotal`, `throttledAtMs` (see HttpProducer).
//
// Non-retryable 4xx (e.g. 400 malformed) still throws immediately so
// operator misconfigurations fail loud.

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
  /** Wave 7.0.5.A — accepted for back-compat; IGNORED as of 7.0.6.22. The
   *  producer no longer caps retries (data-loss on backpressure is
   *  unacceptable). Leaving the field in the type so older callers compile
   *  without churn. */
  maxRetries?: number;
  /** Wave 7.0.5.A — opt out of /load/checkpoints fetch on first add() (tests
   *  + back-compat for callers that don't speak the resume contract). */
  resumeFromCheckpoints?: boolean;
  /** Wave 7.0.6.22 — cancellation surface. When aborted, in-flight fetches
   *  receive the signal, queued backoff sleeps wake early, and `firstError`
   *  is populated so subsequent add/flush/close reject with the abort. */
  signal?: AbortSignal;
  /** Wave 7.0.6.22 — fires once per throttled-state edge. `true` on the
   *  first 429 in a batch (when the local `throttled` flag flips on),
   *  `false` on the first 2xx after that (when it clears). The worker_thread
   *  uses this to forward throttled state to the panel via postMessage.
   *  Idempotent — no edge ⇒ no call. */
  onThrottleChange?: (throttled: boolean) => void;
  /** Wave 7.0.6.22 — wall-clock time source (test seam). Defaults to
   *  Date.now. Used only to stamp `throttledAtMs` when a 429 arrives. */
  now?: () => number;
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
  /** Wave 7.0.5.A — count of rows short-circuited by the resume watermark
   *  fetched from /load/checkpoints. */
  readonly rowsSkipped: number;
  /** Wave 7.0.5.A — count of batches abandoned after exceeding maxRetries.
   *  Wave 7.0.6.22 — always 0 (the give-up cap was removed). Kept for
   *  back-compat with existing /ingest/bulk/runs status consumers. */
  readonly hardErrors: number;
  /** Wave 7.0.5.A — resume watermark loaded from /load/checkpoints, or null
   *  when no checkpoint was found (fresh run). */
  readonly resumeUlid: string | null;
  /** Wave 7.0.6.22 — true while at least one in-flight batch is in the
   *  retry loop after observing a 429. Cleared on the next 2xx. Drives the
   *  rate-gauge "throttled" indicator surfaced to the UI panel. */
  readonly throttled: boolean;
  /** Wave 7.0.6.22 — monotonic count of retry attempts (429 + 5xx + network)
   *  across all batches. Distinct from `throttle429` which counts only 429s. */
  readonly retriesTotal: number;
  /** Wave 7.0.6.22 — wall-clock ms of the last 429 observed, or null when
   *  no 429 has been seen this process. */
  readonly throttledAtMs: number | null;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_IN_FLIGHT = 64;
// Wave 7.0.6.22 — adaptive backoff schedule. 100ms initial, doubled per
// retry, capped at 5s. Full jitter ([0, exp]) prevents the synchronized-
// retry stampede a pure exponential schedule would create across N
// parallel workers all unblocked by the same dispatcher settle.
const MAX_BACKOFF_MS = 5000;
const BASE_BACKOFF_MS = 100;
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
  const baseUrl = opts.url.replace(/\/+$/, "");
  const endpoint = baseUrl + "/load/rows";
  const checkpointsEndpoint = baseUrl + "/load/checkpoints";
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxInFlight = Math.max(1, opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  // Wave 7.0.6.22 — opts.maxRetries is accepted for back-compat but ignored;
  // see the doc-comment on HttpProducerOptions.maxRetries for rationale.
  void opts.maxRetries;
  const resumeEnabled = opts.resumeFromCheckpoints !== false;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  if (!fetchImpl) {
    throw new Error("createHttpProducer: global fetch unavailable; pass fetchImpl");
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const signal = opts.signal;
  const onThrottleChange = opts.onThrottleChange;
  const log = opts.logger;

  const buffer: SensitivityRow[] = [];
  const stats = {
    rowsSent: 0,
    batchCount: 0,
    throttle429: 0,
    inFlight: 0,
    rowsSkipped: 0,
    hardErrors: 0,
    retriesTotal: 0,
    throttledAtMs: null as number | null,
  };
  // Per-batch throttled flags live in `throttledBatches`; the public
  // `throttled` getter is `throttledBatches > 0`. Tracking a count (not a
  // single bool) is the only correct shape for the multi-in-flight case —
  // one batch clearing on 2xx must not flip the worker-wide flag off while
  // another batch is still in the 429 retry loop.
  let throttledBatches = 0;
  function emitThrottle(next: boolean): void {
    if (!onThrottleChange) return;
    onThrottleChange(next);
  }
  const byClass: Record<string, number> = {};
  const inFlightSet = new Set<Promise<void>>();
  const waiters: Array<() => void> = [];
  let firstError: unknown = null;
  let closed = false;
  // Wave 7.0.5.A — lazy resume-watermark fetch. The first add() call awaits
  // /load/checkpoints once; every subsequent add() reuses the cached promise
  // so concurrent producers see a single network round-trip.
  let resumeUlid: string | null = null;
  let resumePromise: Promise<void> | null = null;

  async function loadResumeWatermark(): Promise<void> {
    if (!resumeEnabled) return;
    try {
      const res = await fetchImpl(checkpointsEndpoint, { method: "GET" });
      if (!res.ok) {
        // Not fatal — a fresh bulk-loader without the endpoint or a 404
        // means there's no checkpoint to honour. Run from row zero.
        await res.text().catch(() => undefined);
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { resume_ulid?: string | null }
        | null;
      const r = body?.resume_ulid;
      if (typeof r === "string" && r.length > 0) {
        resumeUlid = r;
        log?.info?.(
          { evt: "bulk-load-resume", resume_ulid: r, url: checkpointsEndpoint },
          "bulk-loader resume watermark loaded",
        );
      }
    } catch (err) {
      // Network-level failure on the bootstrap fetch is non-fatal — the
      // run starts from row zero (worst case: a few duplicate HSETs, which
      // are idempotent for sens:<ulid>).
      log?.warn?.(
        { evt: "bulk-load-resume-failed", err: String(err), url: checkpointsEndpoint },
        "bulk-loader resume watermark fetch failed; starting from row zero",
      );
    }
  }

  function ensureResumeLoaded(): Promise<void> {
    if (!resumeEnabled) return Promise.resolve();
    if (!resumePromise) resumePromise = loadResumeWatermark();
    return resumePromise;
  }

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

  // Wave 7.0.6.22 — abort-aware sleep. Races the timer against the signal
  // so a Stop click wakes the loop within one tick instead of waiting out
  // the current 5s cap. The signal listener is added/removed per call so a
  // long-lived signal does not accumulate listeners across N retries.
  async function abortableSleep(ms: number): Promise<void> {
    if (signal?.aborted) return;
    if (!signal) {
      await sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void sleep(ms).then(() => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  function abortError(): Error {
    return new Error("http-producer: aborted");
  }

  async function postBatch(batch: SensitivityRow[]): Promise<void> {
    const payload = JSON.stringify(batch.map(toBulkRow));
    let attempt = 0;
    let consec429 = 0;
    // Local throttled latch — flipped on the first 429 in this batch, cleared
    // on the next 2xx. Updates `throttledBatches` (worker-wide counter) so
    // multi-batch in-flight cases aggregate correctly.
    let batchThrottled = false;
    function setBatchThrottled(next: boolean): void {
      if (next === batchThrottled) return;
      batchThrottled = next;
      if (next) {
        throttledBatches += 1;
        if (throttledBatches === 1) emitThrottle(true);
      } else {
        throttledBatches -= 1;
        if (throttledBatches === 0) emitThrottle(false);
      }
    }
    // Wave 7.0.6.22 — infinite retry on 429/5xx/network. No max-attempts
    // cap: row loss on backpressure is unacceptable. Abort is the only
    // exit besides 2xx / non-retryable 4xx.
    try {
      while (true) {
        if (signal?.aborted) throw abortError();
        let res: Response;
        try {
          res = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
            ...(signal ? { signal } : {}),
          });
        } catch (err) {
          if (signal?.aborted) throw abortError();
          // Network-level failure — treat like a transient 5xx and back off.
          stats.retriesTotal += 1;
          await abortableSleep(backoffMs(attempt));
          if (signal?.aborted) throw abortError();
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
          setBatchThrottled(false);
          return;
        }
        if (res.status === 429) {
          stats.throttle429++;
          stats.retriesTotal += 1;
          consec429++;
          stats.throttledAtMs = now();
          setBatchThrottled(true);
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
          await abortableSleep(backoffMs(attempt));
          if (signal?.aborted) throw abortError();
          attempt++;
          continue;
        }
        if (res.status >= 500 && res.status < 600) {
          await res.text().catch(() => undefined);
          stats.retriesTotal += 1;
          await abortableSleep(backoffMs(attempt));
          if (signal?.aborted) throw abortError();
          attempt++;
          if (attempt > SLOW_SHARD_WARN_AFTER) {
            log?.warn?.(
              { evt: "bulk-load-5xx-retry", url: endpoint, status: res.status, attempt },
              "bulk-loader returned 5xx; backing off",
            );
          }
          continue;
        }
        // 4xx other than 429 (e.g. 400 malformed) — these are operator-
        // fixable misconfigurations. Surface the body so the generator log
        // explains why ingest stopped.
        const body = await res.text().catch(() => "");
        throw new Error(`bulk-loader ${res.status} ${endpoint}: ${body.slice(0, 256)}`);
      }
    } finally {
      // Ensure the batch's throttle latch is always cleared on exit (success,
      // 4xx throw, or abort) so the worker-wide counter never leaks.
      setBatchThrottled(false);
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
      // Wave 7.0.5.A — fetch the resume watermark on the first add(). The
      // call is memoised so concurrent producers share the round-trip.
      await ensureResumeLoaded();
      if (firstError) throw firstError;
      // ULIDs are lex-sortable so `<=` against the watermark is the resume
      // contract: any row already persisted by the previous run is skipped
      // without buffering or counting toward batchCount/byClass.
      if (resumeUlid !== null && row._id <= resumeUlid) {
        stats.rowsSkipped += 1;
        return;
      }
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
    get rowsSkipped() { return stats.rowsSkipped; },
    get hardErrors() { return stats.hardErrors; },
    get resumeUlid() { return resumeUlid; },
    get throttled() { return throttledBatches > 0; },
    get retriesTotal() { return stats.retriesTotal; },
    get throttledAtMs() { return stats.throttledAtMs; },
  };
}
