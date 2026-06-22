// Wave 7.0.1.B — per-connection buffered pipelined writer.
//
// Each worker owns one ioredis non-cluster socket from the 7.0.1.A pool and
// flushes batched HSETs to `sens:<ulid>` via a single pipeline.exec(). Keys
// carry NO `{...}` hash tag — ULIDs are CRC16-uniform across slots and the
// Enterprise proxy's `all-master-shards` policy fans the pooled connections
// across master nodes.
//
// Flush triggers: (a) buffer hits batchSize, (b) idle-flush timer fires after
// no push for idleFlushMs, (c) drain() is called explicitly. Errors from
// `pipeline.exec()` are reported per-row in the [err, reply] tuples: permanent
// errors (WRONGTYPE / syntax / protocol) dead-letter immediately; everything
// else (connection drop / timeout / BUSY / MASTERDOWN) is requeued with a
// bounded retry count before dead-lettering. Dead-lettered rows append to a
// capped Redis Stream `bulk-loader:dead` for forensic review.

// Structural mirror of `SensitivityRiskValue` in shared/schema/src/types.ts.
// Kept inline (rather than importing @frtb/schema) so the bulk-loader stays a
// leaf dependency in the workspace graph — the only field shape the writer
// cares about is the raw-sensitivity union, and the slim contract is fixed.
export type SensitivityRiskValue =
  | number
  | number[]
  | { spot: number }
  | { [tenorLabel: string]: number }
  | { cvr_up: number; cvr_down: number }
  | { cvr_up: number[]; cvr_down: number[] };

// Slim-doc input row. The dispatcher hands these to enqueue(); how they got
// there is out-of-scope for this wave (Wave 7.0.1.C wires the generator).
export interface Row {
  id: string;
  risk_class: string;
  bucket: string;
  sensitivity_type: "Delta" | "Vega" | "Curvature";
  book?: string;
  trade_id?: string;
  risk_factor?: string;
  desk?: string;
  risk_value: SensitivityRiskValue;
  tenor?: string | readonly string[];
}

export interface WorkerPipeline {
  call(command: string, ...args: unknown[]): WorkerPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface WorkerClient {
  pipeline(): WorkerPipeline;
  call(command: string, ...args: unknown[]): Promise<unknown>;
}

export interface WorkerMetrics {
  id: number;
  queued: number;
  flushed: number;
  errors: number;
  retries: number;
  deadLettered: number;
  lastFlushLatencyMs: number | null;
  lastFlushAt: number | null;
}

export interface WorkerOptions {
  id: number;
  client: WorkerClient;
  batchSize: number;
  idleFlushMs: number;
  maxRetries?: number;
  deadLetterStream?: string;
  deadLetterMaxLen?: number;
  onSettle?: (count: number) => void;
  now?: () => number;
  logger?: {
    warn?: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

export interface WorkerHandle {
  id: number;
  push(row: Row): void;
  drain(): Promise<void>;
  stop(): Promise<void>;
  metrics(): WorkerMetrics;
  bufferLength(): number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DEAD_LETTER_STREAM = "bulk-loader:dead";
const DEFAULT_DEAD_LETTER_MAXLEN = 10_000;

// Wave 7.0.1.B — slim TAG set per Phase 0 verifier §3.1: drop `trader` and
// `_calibration` from the fat-doc TAGs. Must match idx:sens:slim
// (shared/rqe/src/index.mjs IDX_SLIM_SCHEMA_FIELDS) field-for-field.
const TAG_FIELDS = Object.freeze([
  "risk_class",
  "bucket",
  "sensitivity_type",
  "book",
  "trade_id",
  "risk_factor",
  "desk",
] as const);

// Permanent errors that should bypass retry and go straight to the dead-letter
// stream. ioredis surfaces these as Error subclasses whose message text starts
// with the WRONGTYPE / ERR syntax / Protocol error prefix returned by Redis.
export function isPermanentError(err: Error): boolean {
  const m = err.message || "";
  return /^WRONGTYPE/.test(m) || /syntax error/i.test(m) || /Protocol error/i.test(m);
}

// Flattens a slim row into the HSET field-value argv. NUMERIC fields follow
// `s_<class>_<leg>[_<tenor>]` per the Wave 7.0.0.B lazy-math contract:
// Delta/Vega scalar (`{spot}`) → `s_<class>_<leg>`; Delta/Vega perTenor
// (`{<tenor>: v}`) → `s_<class>_<leg>_<tenor>`; Curvature scalar
// (`{cvr_up, cvr_down}`) → `s_<class>_cvr_up` / `s_<class>_cvr_down`;
// Curvature perTenor (`{cvr_up: [], cvr_down: []}`) → per-tenor pair.
// Bare-number / legacy-array shapes are supported for parity with the
// existing ingest path (enrichDoc in services/ingest/src/consumer.ts).
export function rowToHashFields(row: Row): string[] {
  const args: string[] = [];
  for (const k of TAG_FIELDS) {
    const v = row[k];
    if (v !== undefined && v !== null) args.push(k, String(v));
  }
  const lower = String(row.risk_class).toLowerCase();
  const sens = row.sensitivity_type;
  const rv = row.risk_value;

  if (sens === "Curvature") {
    if (rv != null && typeof rv === "object" && !Array.isArray(rv)) {
      const cvr = rv as { cvr_up?: unknown; cvr_down?: unknown };
      const up = cvr.cvr_up;
      const dn = cvr.cvr_down;
      if (Array.isArray(up) && Array.isArray(dn)) {
        const tenors = Array.isArray(row.tenor) ? (row.tenor as readonly string[]) : null;
        if (tenors) {
          const n = Math.min(up.length, dn.length, tenors.length);
          for (let i = 0; i < n; i++) {
            const t = tenors[i];
            const u = up[i];
            const d = dn[i];
            if (typeof t === "string" && typeof u === "number") {
              args.push(`s_${lower}_cvr_up_${t}`, String(u));
            }
            if (typeof t === "string" && typeof d === "number") {
              args.push(`s_${lower}_cvr_down_${t}`, String(d));
            }
          }
        }
      } else if (typeof up === "number" && typeof dn === "number") {
        args.push(`s_${lower}_cvr_up`, String(up));
        args.push(`s_${lower}_cvr_down`, String(dn));
      }
    }
    return args;
  }

  const leg = sens === "Vega" ? "vega" : "delta";
  if (rv != null && typeof rv === "object" && !Array.isArray(rv)) {
    const obj = rv as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === "spot" && typeof obj.spot === "number") {
      args.push(`s_${lower}_${leg}`, String(obj.spot));
    } else {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "number") args.push(`s_${lower}_${leg}_${k}`, String(v));
      }
    }
  } else if (Array.isArray(rv)) {
    const tenor = row.tenor;
    const labels = Array.isArray(tenor) ? (tenor as readonly string[]) : null;
    if (labels) {
      const n = Math.min(rv.length, labels.length);
      for (let i = 0; i < n; i++) {
        const v = rv[i];
        const t = labels[i];
        if (typeof v === "number" && typeof t === "string") {
          args.push(`s_${lower}_${leg}_${t}`, String(v));
        }
      }
    }
  } else if (typeof rv === "number") {
    args.push(`s_${lower}_${leg}`, String(rv));
  }

  return args;
}

interface BufferedRow {
  row: Row;
  attempts: number;
}

export function createWorker(opts: WorkerOptions): WorkerHandle {
  const id = opts.id;
  const batchSize = opts.batchSize;
  const idleFlushMs = opts.idleFlushMs;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const deadLetterStream = opts.deadLetterStream ?? DEFAULT_DEAD_LETTER_STREAM;
  const deadLetterMaxLen = opts.deadLetterMaxLen ?? DEFAULT_DEAD_LETTER_MAXLEN;
  const onSettle = opts.onSettle;
  const now = opts.now ?? Date.now;
  const log = opts.logger;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`createWorker(${id}): batchSize must be a positive integer`);
  }
  if (!Number.isFinite(idleFlushMs) || idleFlushMs < 0) {
    throw new Error(`createWorker(${id}): idleFlushMs must be a non-negative number`);
  }

  const buffer: BufferedRow[] = [];
  const metrics: WorkerMetrics = {
    id,
    queued: 0,
    flushed: 0,
    errors: 0,
    retries: 0,
    deadLettered: 0,
    lastFlushLatencyMs: null,
    lastFlushAt: null,
  };

  let stopped = false;
  let flushPromise: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  function clearIdle(): void {
    if (idleTimer != null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdle(): void {
    clearIdle();
    if (idleFlushMs <= 0) return;
    const t = setTimeout(() => {
      idleTimer = null;
      if (buffer.length > 0) void scheduleFlush();
    }, idleFlushMs);
    if (typeof t.unref === "function") t.unref();
    idleTimer = t;
  }

  function scheduleFlush(): Promise<void> {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      try {
        while (buffer.length > 0) {
          const batch = buffer.splice(0, batchSize);
          await flushBatch(batch);
        }
      } finally {
        flushPromise = null;
      }
    })();
    return flushPromise;
  }

  async function deadLetter(row: Row, err: Error): Promise<void> {
    metrics.deadLettered++;
    try {
      await opts.client.call(
        "XADD",
        deadLetterStream,
        "MAXLEN",
        "~",
        String(deadLetterMaxLen),
        "*",
        "worker_id",
        String(id),
        "key",
        `sens:${row.id}`,
        "err",
        err.message,
        "row",
        JSON.stringify(row),
      );
    } catch (xaddErr) {
      // Best-effort. If the dead-letter stream is unreachable we cannot do
      // much beyond logging — the row is lost from this worker's point of
      // view but the metric counter still increments.
      log?.warn?.(
        { worker_id: id, err: String(xaddErr) },
        "dead-letter XADD failed",
      );
    }
  }

  async function flushBatch(batch: BufferedRow[]): Promise<void> {
    if (batch.length === 0) return;
    const start = now();
    const pipeline = opts.client.pipeline();
    const indexed: Array<{ entry: BufferedRow; piped: boolean }> = [];
    for (const entry of batch) {
      const fields = rowToHashFields(entry.row);
      if (fields.length === 0) {
        // Row had no writable fields — treat as a permanent malformed row
        // and dead-letter it directly without occupying a pipeline slot.
        indexed.push({ entry, piped: false });
        continue;
      }
      pipeline.call("HSET", `sens:${entry.row.id}`, ...fields);
      indexed.push({ entry, piped: true });
    }

    const malformed = indexed.filter((x) => !x.piped);
    for (const m of malformed) {
      await deadLetter(m.entry.row, new Error("malformed row: empty field set"));
      onSettle?.(1);
    }

    if (indexed.every((x) => !x.piped)) {
      metrics.lastFlushLatencyMs = now() - start;
      metrics.lastFlushAt = now();
      return;
    }

    let replies: Array<[Error | null, unknown]> | null = null;
    let pipelineErr: Error | null = null;
    try {
      replies = await pipeline.exec();
    } catch (err) {
      pipelineErr = err instanceof Error ? err : new Error(String(err));
    }

    let replyIdx = 0;
    for (const { entry, piped } of indexed) {
      if (!piped) continue; // already dead-lettered above
      let err: Error | null = null;
      if (pipelineErr) {
        err = pipelineErr;
      } else if (replies) {
        const tuple = replies[replyIdx];
        replyIdx++;
        if (tuple && tuple[0]) err = tuple[0];
      } else {
        err = new Error("pipeline aborted (null replies)");
      }
      if (!err) {
        metrics.flushed++;
        onSettle?.(1);
        continue;
      }
      metrics.errors++;
      if (isPermanentError(err)) {
        await deadLetter(entry.row, err);
        onSettle?.(1);
        continue;
      }
      const nextAttempt = entry.attempts + 1;
      if (nextAttempt >= maxRetries) {
        await deadLetter(entry.row, err);
        onSettle?.(1);
        continue;
      }
      // Transient — requeue with incremented attempt counter. Push to the
      // front so retries drain ahead of fresh work (matches the "head of
      // line" intent in the failure-semantics brief).
      metrics.retries++;
      buffer.unshift({ row: entry.row, attempts: nextAttempt });
    }

    metrics.lastFlushLatencyMs = now() - start;
    metrics.lastFlushAt = now();
  }

  function push(row: Row): void {
    if (stopped) {
      throw new Error(`worker ${id}: push after stop`);
    }
    buffer.push({ row, attempts: 0 });
    metrics.queued++;
    if (buffer.length >= batchSize) {
      clearIdle();
      void scheduleFlush();
    } else {
      armIdle();
    }
  }

  async function drain(): Promise<void> {
    clearIdle();
    if (buffer.length > 0) void scheduleFlush();
    while (flushPromise) {
      await flushPromise;
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    await drain();
    clearIdle();
  }

  return {
    id,
    push,
    drain,
    stop,
    metrics: () => ({ ...metrics }),
    bufferLength: () => buffer.length,
  };
}
