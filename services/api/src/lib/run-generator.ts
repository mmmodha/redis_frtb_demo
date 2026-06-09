// Wave 5.95C — shared run-loop helper used by both `/generator/start`
// (JSON) and `/generator/start/stream` (SSE) routes. Owns producer
// construction (router + MAXLEN + flow-control), the per-row generation
// loop, and stop-condition resolution. Both routes pass the same wiring
// into here so a future MAXLEN/flow-control tweak only edits one path.

import type { FastifyBaseLogger } from "fastify";
import type { Schema } from "@frtb/schema";
import {
  createRowGenerator,
  createStreamProducer,
  createStreamFlowControl,
  type FlowControlOptions,
} from "@frtb/generator";
import type { StreamRouter } from "@frtb/stream-router";
import type { RedisLike } from "../redis-like.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";

// Wave 5.47c — resolved stop_when after validation; same shape as the
// request `stop_when` but with each field guaranteed to be a valid
// positive number.
export interface StopWhen {
  rows?: number;
  memory_pct?: number;
  elapsed_seconds?: number;
}

// Wave 5.47c — which condition halted the loop. "rows" is the historical
// default (ran to count).
export type StopReason = "rows" | "memory" | "elapsed" | "cancelled" | "error";

// Wave 5.47d — class-sequence picker. `pick(i)` returns the class to use
// for the i-th row. The route resolves either round-robin or
// largest-deficit interleaver and hands the picker to this loop.
export interface ClassPicker {
  pick(i: number): string;
}

export interface RunGeneratorOptions {
  // Redis + logging context.
  redis: RedisLike;
  log: FastifyBaseLogger;
  evt: string;                  // "generator-start" | "generator-stream"
  run_id: string;
  target_label: string;
  // Generator construction.
  schema: Schema;
  seed: string | number | undefined;
  sensitivity_types: string[];
  tradePool: number | undefined;
  factorPool: number | undefined;
  // Producer construction.
  streamName: string;
  batchSize: number;
  pipelineWindow?: number;       // omitted by SSE route (parity with pre-5.95C)
  router: StreamRouter | undefined;
  streamMaxLen: number | undefined;
  flowControlOptions: FlowControlOptions | undefined;
  // Per-row loop.
  rows: number;
  picker: ClassPicker;
  stopWhen: StopWhen;
  // Optional: SSE-only knobs. JSON route omits both.
  cancelFlag?: { cancelled: boolean };
  onTick?: (rowsSent: number, elapsedNs: bigint) => void;
}

export interface RunGeneratorResult {
  rows_queued: number;
  stop_reason: StopReason;
  ms: number;                   // wall time in ms (float)
  // Populated only on a producer/redis error; callers map this to the
  // route-appropriate response (JSON 4xx/5xx body or SSE error frame).
  error?: {
    message: string;
    translated?: { status: number; body: unknown };
  };
}

// Wave 5.47c — parse Redis "INFO memory" text into the numeric fields
// used by the memory_pct stop condition. Returns 0 for missing keys so
// callers can fall back to other denominators.
function parseInfoMemory(text: string): {
  used_memory: number;
  used_memory_rss: number;
  total_system_memory: number;
  maxmemory: number;
} {
  const get = (key: string): number => {
    const m = new RegExp(`^${key}:(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    used_memory: get("used_memory"),
    used_memory_rss: get("used_memory_rss"),
    total_system_memory: get("total_system_memory"),
    maxmemory: get("maxmemory"),
  };
}

// Wave 5.47c — current memory pct from a parsed INFO memory snapshot.
// Prefers used_memory / maxmemory when maxmemory > 0; otherwise falls
// back to used_memory_rss / total_system_memory. Returns null when
// neither denominator is available (so the stop check can no-op).
function memoryPct(info: ReturnType<typeof parseInfoMemory>): number | null {
  if (info.maxmemory > 0 && info.used_memory > 0) {
    return (info.used_memory / info.maxmemory) * 100;
  }
  if (info.total_system_memory > 0 && info.used_memory_rss > 0) {
    return (info.used_memory_rss / info.total_system_memory) * 100;
  }
  return null;
}

// Wave 5.95C — shared producer + run-loop. Constructs the generator and
// producer (with router / MAXLEN / flow-control all wired identically
// across routes), then drives the per-row XADD loop with the same
// stop-condition checks the two routes used to carry independently.
// Never throws: producer/redis errors surface via `result.error`.
export async function runGeneratorLoop(
  opts: RunGeneratorOptions,
): Promise<RunGeneratorResult> {
  const t0 = process.hrtime.bigint();
  const startedAtMs = Date.now();

  const generator = createRowGenerator(opts.schema, {
    seed: opts.seed,
    sensitivityTypes: opts.sensitivity_types,
    tradePoolSize: opts.tradePool,
    factorPoolSize: opts.factorPool,
  });
  // Wave 5.92C-fix — build the producer-side XLEN credit gate only when
  // the caller asks for it (default is no gate, parity with the pre-fix
  // behaviour on both routes).
  const flowControl = opts.flowControlOptions
    ? createStreamFlowControl(
      opts.redis as unknown as Parameters<typeof createStreamFlowControl>[0],
      opts.flowControlOptions,
      opts.log,
    )
    : undefined;
  // Wave 5.92C-fix — status-line log when the approximate MAXLEN cap is
  // in effect on XADD (parity with the CLI's --stream-maxlen plumbing).
  if (opts.streamMaxLen !== undefined) {
    opts.log.info(
      { evt: opts.evt, run_id: opts.run_id, stream_maxlen: opts.streamMaxLen },
      `MAXLEN ~ ${opts.streamMaxLen} in effect on XADD`,
    );
  }
  const producer = createStreamProducer(
    opts.redis as unknown as Parameters<typeof createStreamProducer>[0],
    {
      stream: opts.streamName,
      batchSize: opts.batchSize,
      ...(opts.pipelineWindow !== undefined ? { pipelineWindow: opts.pipelineWindow } : {}),
      router: opts.router,
      streamMaxLen: opts.streamMaxLen,
      flowControl,
    },
  );

  // Wave 5.47c — stop-condition bookkeeping. Defaults to "rows" for
  // backward compat (the historical "ran to row count" terminal).
  let stopReason: StopReason = "rows";
  let lastMemPollBatchCount = 0;
  let lastMemPollAtMs = startedAtMs;

  const tick = (): void => {
    if (opts.onTick) opts.onTick(producer.rowsSent, process.hrtime.bigint() - t0);
  };

  try {
    for (let i = 0; i < opts.rows; i++) {
      // Wave 5.40a — cancellation is opt-in (SSE route only). The JSON
      // route omits cancelFlag so this check is a no-op there.
      if (opts.cancelFlag?.cancelled) break;
      // Wave 5.47c — check active stop conditions BEFORE adding the
      // next row so the terminal frame reflects "stopped at N rows".
      if (opts.stopWhen.elapsed_seconds !== undefined
        && (Date.now() - startedAtMs) / 1000 >= opts.stopWhen.elapsed_seconds) {
        stopReason = "elapsed";
        break;
      }
      if (opts.stopWhen.memory_pct !== undefined) {
        const dueByBatches = producer.batchCount - lastMemPollBatchCount >= 25;
        const dueByTime = Date.now() - lastMemPollAtMs >= 1000;
        if (dueByBatches && dueByTime) {
          lastMemPollBatchCount = producer.batchCount;
          lastMemPollAtMs = Date.now();
          try {
            const text = await opts.redis.info("memory");
            const pct = memoryPct(parseInfoMemory(text));
            if (pct !== null && pct >= opts.stopWhen.memory_pct) {
              stopReason = "memory";
              break;
            }
          } catch { /* tolerate transient INFO failure; next poll retries */ }
        }
      }
      const riskClass = opts.picker.pick(i);
      const row = generator.generate(riskClass);
      await producer.add(row);
      tick();
    }
    await producer.flush();
    await producer.close();
    tick();
  } catch (err) {
    try { await producer.close(); } catch { /* swallow flush-on-close error */ }
    const translated = translateRedisError(err, opts.target_label, getBootstrapStatus().phase);
    const message = err instanceof Error ? err.message : String(err);
    opts.log.warn({ evt: opts.evt, run_id: opts.run_id, err: message });
    return {
      rows_queued: producer.rowsSent,
      stop_reason: stopReason,
      ms: Number(process.hrtime.bigint() - t0) / 1e6,
      error: translated ? { message, translated } : { message },
    };
  }

  return {
    rows_queued: producer.rowsSent,
    stop_reason: stopReason,
    ms: Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

