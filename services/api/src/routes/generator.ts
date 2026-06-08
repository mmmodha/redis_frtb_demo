// POST /generator/start — in-process synthetic-row generator backed by the
// @frtb/generator library. Drives the Ingest panel "Run generator" button so
// the demo can top up `sensitivities:in` without exec-ing the standalone CLI.
// The container-mode CLI (`services/generator/src/cli.ts`, profiles: ["tools"])
// stays the canonical bulk-seed path; this endpoint is the UI-driven
// small-batch top-up path (≤2000 rows/call).

import { ulid } from "ulid";
import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import {
  createRowGenerator,
  createStreamProducer,
} from "@frtb/generator";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";
import { corsHeadersForRequest } from "../cors-headers.ts";

interface GeneratorStartBody {
  rows?: number;
  classes?: string[];
  sensitivity_types?: string[];
  seed?: string | number;
  // Wave 5.17a — tenant reshape: optional pool sizes for aux-RNG trade_id and
  // risk_factor fields. Defaults preserve smoke-run-16 byte-equivalence.
  trade_pool_size?: number;
  factor_pool_size?: number;
  // Wave 5.47d — explicit per-class row counts. When present, the generator
  // draws each class exactly the configured count and the total row count is
  // the sum (or must equal `rows` if both are supplied). When absent, falls
  // back to round-robin via `classes` + `rows`.
  class_split?: Record<string, number>;
  // Wave 5.47c — optional stop conditions. Whichever trips FIRST halts the
  // run. If omitted, behaviour is exactly today's (defaults to rows).
  stop_when?: {
    rows?: number;
    memory_pct?: number;
    elapsed_seconds?: number;
  };
  // Wave 5.84A — generator-throughput knobs. Both optional. batch_size sets
  // the XADD pipeline batch size (default DEFAULT_BATCH_SIZE). pipeline_window
  // bounds how many pipeline.exec() calls may be in flight at once (default
  // DEFAULT_PIPELINE_WINDOW=1, bit-identical to pre-5.84A).
  batch_size?: number;
  pipeline_window?: number;
}

// Wave 5.47c — resolved stop_when after validation; same shape as the input
// stop_when but with each field guaranteed to be a valid positive number.
interface StopWhen {
  rows?: number;
  memory_pct?: number;
  elapsed_seconds?: number;
}
export type StopReason = "rows" | "memory" | "elapsed" | "cancelled" | "error";

export interface GeneratorRoutesOpts {
  streamName?: string;
  // Wave 5.20c — SSE progress-frame cadence for /generator/start/stream.
  // Tests override this so a small synthetic batch still emits ≥1 progress
  // frame before the terminal frame.
  sseProgressIntervalMs?: number;
  // Wave 5.21i — resolved @fastify/cors allow-list value. Threaded in so the
  // hijacked SSE response carries the matching access-control-allow-origin
  // header that the cors plugin's onSend hook can't inject for a hijack.
  corsAllowed?: true | string | string[];
  // Wave 5.40a — grace window (ms) during which a terminal run remains
  // queryable via GET /generator/runs/:id/status so a refresh right after
  // completion still surfaces the summary. Tests dial this down.
  terminalGraceMs?: number;
}

const DEFAULT_ROWS = 200;
const DEFAULT_CLASSES = ["GIRR", "Equity", "FX"] as const;
const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega"] as const;

// Wave 5.84A — generator throughput defaults. DEFAULT_BATCH_SIZE was bumped
// from 200 to 1000 (the CLI default) to halve round-trip overhead on the
// in-process api path. DEFAULT_PIPELINE_WINDOW=1 keeps single-in-flight
// semantics by default; callers opt into windowing via `pipeline_window`.
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_PIPELINE_WINDOW = 1;
const MAX_BATCH_SIZE = 50_000;
const MAX_PIPELINE_WINDOW_API = 8;

// Wave 5.40a — module-local registry of in-flight + recently-terminal runs.
// The generation loop runs as a detached promise that owns the lifecycle of
// these entries; the SSE handler is now a pure transport that pipes the
// state into frames and stops writing on client disconnect. Cancellation is
// only triggered explicitly via POST /generator/cancel/:run_id (closing the
// browser tab no longer cancels the run — see Wave 5.40 spec).
interface ActiveRun {
  run_id: string;
  status: "running" | "done" | "cancelled" | "error";
  rows_done: number;
  rows_total: number;
  elapsed_ms: number;
  rows_per_sec: number;
  started_at_iso: string;
  classes: string[];
  sensitivity_types: string[];
  cancelFlag: { cancelled: boolean };
  error?: string;
  terminal_at_ms?: number;
  // Wave 5.47c — which condition halted the loop. Defaults to "rows" for
  // backward compat (the historical "ran to row count" terminal).
  stop_reason?: StopReason;
}
const activeRuns = new Map<string, ActiveRun>();

// The producer accepts an ioredis Redis|Cluster client — the only surface it
// uses is `.pipeline()`. RedisLike (the api's narrow interface) is widened
// here at the call site by structural typing; both the real ioredis client
// and the test stub satisfy it.
type PipelineClient = {
  pipeline(): {
    xadd(key: string, id: string, ...fields: string[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
};

// Wave 5.47d — class-sequence pickers. Both return the class to use for the
// i-th row. Round-robin keeps the existing modulo behaviour (O(1) per pick,
// no allocation). The Bresenham-style interleaver expands a class_split map
// so progress events show a consistent mix instead of "all GIRR then all FX".
interface ClassPicker {
  pick(i: number): string;
}
function roundRobinPicker(resolvedClasses: string[]): ClassPicker {
  return { pick: (i) => resolvedClasses[i % resolvedClasses.length]! };
}
// Largest-deficit interleaver: at each output slot, advance the class whose
// next placement is earliest on the fractional timeline (placed+0.5)/count.
// Deterministic and produces an even mix (e.g. {GIRR:100, FX:50} → GFGG FGGF…).
function interleavedSequence(splits: Array<{ klass: string; count: number }>): string[] {
  const active = splits.filter((s) => s.count > 0);
  let total = 0;
  for (const s of active) total += s.count;
  const out: string[] = new Array(total);
  const placed: number[] = active.map(() => 0);
  for (let i = 0; i < total; i++) {
    let bestIdx = -1;
    let bestKey = Infinity;
    for (let j = 0; j < active.length; j++) {
      if (placed[j]! >= active[j]!.count) continue;
      const key = (placed[j]! + 0.5) / active[j]!.count;
      if (key < bestKey) { bestKey = key; bestIdx = j; }
    }
    out[i] = active[bestIdx]!.klass;
    placed[bestIdx]!++;
  }
  return out;
}
function sequencePicker(seq: string[]): ClassPicker {
  return { pick: (i) => seq[i]! };
}

// Wave 5.47d — shared request parser. Validates rows / classes /
// sensitivity_types / pool sizes / class_split and returns the resolved
// values used by both the non-streaming and streaming routes. Returning a
// discriminated union keeps the call sites flat (status + body).
interface ParsedGeneratorRequest {
  ok: true;
  rows: number;
  resolvedClasses: string[];
  sensitivity_types: string[];
  tradePool: number | undefined;
  factorPool: number | undefined;
  picker: ClassPicker;
  stopWhen: StopWhen;
  // Wave 5.84A — resolved generator-throughput knobs (always populated; fall
  // back to DEFAULT_BATCH_SIZE / DEFAULT_PIPELINE_WINDOW when omitted).
  batchSize: number;
  pipelineWindow: number;
}
interface ParsedGeneratorError {
  ok: false;
  status: number;
  error: string;
}
function parseGeneratorRequest(
  body: GeneratorStartBody,
  schema: Schema,
): ParsedGeneratorRequest | ParsedGeneratorError {
  // Wave 5.47c — validate stop_when up front. Each numeric field must be a
  // positive integer (elapsed_seconds may be a finite positive float). At
  // least one of rows/memory_pct/elapsed_seconds must be present when
  // stop_when is supplied.
  const stopWhen: StopWhen = {};
  if (body.stop_when !== undefined) {
    if (typeof body.stop_when !== "object" || body.stop_when === null || Array.isArray(body.stop_when)) {
      return { ok: false, status: 400, error: "stop_when must be an object" };
    }
    const sw = body.stop_when;
    if (sw.rows !== undefined) {
      if (
        typeof sw.rows !== "number"
        || !Number.isFinite(sw.rows)
        || !Number.isInteger(sw.rows)
        || sw.rows <= 0
      ) {
        return { ok: false, status: 400, error: "stop_when.rows must be a positive integer" };
      }
      stopWhen.rows = sw.rows;
    }
    if (sw.memory_pct !== undefined) {
      if (
        typeof sw.memory_pct !== "number"
        || !Number.isFinite(sw.memory_pct)
        || !Number.isInteger(sw.memory_pct)
        || sw.memory_pct < 1
        || sw.memory_pct > 95
      ) {
        return { ok: false, status: 400, error: "stop_when.memory_pct must be an integer in 1..95" };
      }
      stopWhen.memory_pct = sw.memory_pct;
    }
    if (sw.elapsed_seconds !== undefined) {
      if (
        typeof sw.elapsed_seconds !== "number"
        || !Number.isFinite(sw.elapsed_seconds)
        || sw.elapsed_seconds <= 0
        || sw.elapsed_seconds > 86400
      ) {
        return { ok: false, status: 400, error: "stop_when.elapsed_seconds must be a positive number in 1..86400" };
      }
      stopWhen.elapsed_seconds = sw.elapsed_seconds;
    }
    if (stopWhen.rows === undefined && stopWhen.memory_pct === undefined && stopWhen.elapsed_seconds === undefined) {
      return { ok: false, status: 400, error: "stop_when must contain at least one condition" };
    }
  }

  // class_split (if present) defines the per-class row counts. The total row
  // count is the sum and must agree with `rows` if both are supplied.
  let classSplitResolved: Array<{ klass: string; count: number }> | null = null;
  if (body.class_split !== undefined) {
    if (typeof body.class_split !== "object" || body.class_split === null || Array.isArray(body.class_split)) {
      return { ok: false, status: 400, error: "class_split must be an object mapping risk class → count" };
    }
    const entries = Object.entries(body.class_split);
    if (entries.length === 0) {
      return { ok: false, status: 400, error: "class_split cannot be empty if provided" };
    }
    const resolved: Array<{ klass: string; count: number }> = [];
    for (const [klass, count] of entries) {
      if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
        return { ok: false, status: 400, error: `class_split[${klass}] must be a non-negative integer` };
      }
      const upper = String(klass).toUpperCase();
      const canonical = schema.risk_classes[upper] ? upper : schema.risk_classes[klass] ? klass : null;
      if (!canonical) {
        return { ok: false, status: 400, error: `unknown risk class: ${klass}` };
      }
      resolved.push({ klass: canonical, count });
    }
    classSplitResolved = resolved;
  }

  let rows: number;
  if (classSplitResolved) {
    const sum = classSplitResolved.reduce((acc, s) => acc + s.count, 0);
    if (body.rows !== undefined && body.rows !== sum) {
      return {
        ok: false,
        status: 400,
        error: `class_split totals ${sum} but rows is ${body.rows}; omit rows or set rows=${sum}`,
      };
    }
    // Wave 5.47c — stop_when.rows is also checked against the class_split sum
    // (mirrors the rows-vs-class_split rule).
    if (stopWhen.rows !== undefined && stopWhen.rows !== sum) {
      return {
        ok: false,
        status: 400,
        error: `class_split totals ${sum} but stop_when.rows is ${stopWhen.rows}; omit stop_when.rows or set it to ${sum}`,
      };
    }
    rows = sum;
  } else if (stopWhen.rows !== undefined) {
    // Wave 5.47c — stop_when.rows is the row-stop condition. When body.rows
    // is also provided they must agree; otherwise stop_when.rows wins.
    if (body.rows !== undefined && body.rows !== stopWhen.rows) {
      return {
        ok: false,
        status: 400,
        error: `rows is ${body.rows} but stop_when.rows is ${stopWhen.rows}; omit one or set them equal`,
      };
    }
    rows = stopWhen.rows;
  } else {
    rows = body.rows ?? DEFAULT_ROWS;
  }
  // Wave 5.20c — hard MAX_ROWS cap removed; the cluster sanity check in the
  // UI is the user-facing guardrail. Only structural validation remains here.
  if (
    typeof rows !== "number"
    || !Number.isFinite(rows)
    || !Number.isInteger(rows)
    || rows <= 0
    || rows > Number.MAX_SAFE_INTEGER
  ) {
    return { ok: false, status: 400, error: "rows must be a positive integer" };
  }

  let resolvedClasses: string[];
  if (classSplitResolved) {
    // When class_split is provided it fully determines the class set; the
    // top-level `classes` field is ignored to avoid ambiguous behaviour.
    resolvedClasses = classSplitResolved.map((s) => s.klass);
  } else {
    const classes = body.classes && body.classes.length > 0 ? body.classes : [...DEFAULT_CLASSES];
    for (const c of classes) {
      const upper = String(c).toUpperCase();
      if (!schema.risk_classes[upper] && !schema.risk_classes[c]) {
        return { ok: false, status: 400, error: `unknown risk class: ${c}` };
      }
    }
    // Resolve to the canonical key (UPPERCASE) used everywhere downstream —
    // mirrors the calc.ts §Wave 5.15l convention.
    resolvedClasses = classes.map((c) => {
      const upper = String(c).toUpperCase();
      return schema.risk_classes[upper] ? upper : c;
    });
  }

  const sensitivity_types = body.sensitivity_types && body.sensitivity_types.length > 0
    ? body.sensitivity_types
    : [...DEFAULT_SENSITIVITY_TYPES];

  // Wave 5.17a — validate pool sizes if provided (1..10000 / 1..256).
  const tradePool = body.trade_pool_size;
  if (tradePool !== undefined) {
    if (typeof tradePool !== "number" || !Number.isFinite(tradePool) || tradePool < 1 || tradePool > 10000) {
      return { ok: false, status: 400, error: "trade_pool_size must be a number in 1..10000" };
    }
  }
  const factorPool = body.factor_pool_size;
  if (factorPool !== undefined) {
    if (typeof factorPool !== "number" || !Number.isFinite(factorPool) || factorPool < 1 || factorPool > 256) {
      return { ok: false, status: 400, error: "factor_pool_size must be a number in 1..256" };
    }
  }

  // Wave 5.84A — validate optional generator-throughput knobs.
  let batchSize = DEFAULT_BATCH_SIZE;
  if (body.batch_size !== undefined) {
    const bs = body.batch_size;
    if (
      typeof bs !== "number"
      || !Number.isFinite(bs)
      || !Number.isInteger(bs)
      || bs < 1
      || bs > MAX_BATCH_SIZE
    ) {
      return { ok: false, status: 400, error: `batch_size must be an integer in 1..${MAX_BATCH_SIZE}` };
    }
    batchSize = bs;
  }
  let pipelineWindow = DEFAULT_PIPELINE_WINDOW;
  if (body.pipeline_window !== undefined) {
    const pw = body.pipeline_window;
    if (
      typeof pw !== "number"
      || !Number.isFinite(pw)
      || !Number.isInteger(pw)
      || pw < 1
      || pw > MAX_PIPELINE_WINDOW_API
    ) {
      return { ok: false, status: 400, error: `pipeline_window must be an integer in 1..${MAX_PIPELINE_WINDOW_API}` };
    }
    pipelineWindow = pw;
  }

  const picker: ClassPicker = classSplitResolved
    ? sequencePicker(interleavedSequence(classSplitResolved))
    : roundRobinPicker(resolvedClasses);

  return {
    ok: true, rows, resolvedClasses, sensitivity_types, tradePool, factorPool, picker, stopWhen,
    batchSize, pipelineWindow,
  };
}

// Wave 5.47c — parse Redis "INFO memory" text into the numeric fields used
// by the memory_pct stop condition. Returns 0 for missing keys so callers
// can fall back to other denominators.
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
// Prefers used_memory / maxmemory when maxmemory > 0; otherwise falls back
// to used_memory_rss / total_system_memory. Returns null when neither
// denominator is available (so the stop check can no-op gracefully).
function memoryPct(info: ReturnType<typeof parseInfoMemory>): number | null {
  if (info.maxmemory > 0 && info.used_memory > 0) {
    return (info.used_memory / info.maxmemory) * 100;
  }
  if (info.total_system_memory > 0 && info.used_memory_rss > 0) {
    return (info.used_memory_rss / info.total_system_memory) * 100;
  }
  return null;
}

export function registerGeneratorRoutes(
  app: FastifyInstance,
  getRedis: () => RedisLike,
  schema: Schema | undefined,
  opts: GeneratorRoutesOpts = {},
): void {
  const streamName = opts.streamName ?? "sensitivities:in";
  const corsAllowed = opts.corsAllowed ?? "http://localhost:3000";

  app.post<{ Body: GeneratorStartBody }>("/generator/start", async (req, reply) => {
    if (!schema) {
      app.log.warn({ evt: "generator-start", err: "schema-missing" });
      reply.code(503);
      return { error: "schema not loaded; api boot incomplete" };
    }

    const body = (req.body ?? {}) as GeneratorStartBody;
    const parsed = parseGeneratorRequest(body, schema);
    if (!parsed.ok) {
      reply.code(parsed.status);
      return { error: parsed.error };
    }
    const { rows, resolvedClasses, sensitivity_types, tradePool, factorPool, picker, stopWhen, batchSize, pipelineWindow } = parsed;

    const run_id = ulid();
    const t0 = process.hrtime.bigint();
    const startedAtMs = Date.now();

    // Wave 5.16t — resolve active redis per-request so the generator writes
    // to the currently-active profile's stream.
    const redis = getRedis();
    const target_label = getActiveTarget().label;

    const generator = createRowGenerator(schema, {
      seed: body.seed,
      sensitivityTypes: sensitivity_types,
      tradePoolSize: tradePool,
      factorPoolSize: factorPool,
    });
    const producer = createStreamProducer(
      redis as unknown as Parameters<typeof createStreamProducer>[0],
      { stream: streamName, batchSize, pipelineWindow },
    );

    // Wave 5.47c — track which condition halts the loop. Defaults to "rows"
    // for backward compat (the historical behaviour).
    let stopReason: StopReason = "rows";
    let lastMemPollBatchCount = 0;
    let lastMemPollAtMs = startedAtMs;

    try {
      for (let i = 0; i < rows; i++) {
        // Wave 5.47c — check active stop conditions BEFORE adding the next
        // row so the terminal frame reflects "stopped at N rows".
        if (stopWhen.elapsed_seconds !== undefined
          && (Date.now() - startedAtMs) / 1000 >= stopWhen.elapsed_seconds) {
          stopReason = "elapsed";
          break;
        }
        if (stopWhen.memory_pct !== undefined) {
          const dueByBatches = producer.batchCount - lastMemPollBatchCount >= 25;
          const dueByTime = Date.now() - lastMemPollAtMs >= 1000;
          if (dueByBatches && dueByTime) {
            lastMemPollBatchCount = producer.batchCount;
            lastMemPollAtMs = Date.now();
            try {
              const text = await redis.info("memory");
              const pct = memoryPct(parseInfoMemory(text));
              if (pct !== null && pct >= stopWhen.memory_pct) {
                stopReason = "memory";
                break;
              }
            } catch { /* tolerate transient INFO failure; next poll retries */ }
          }
        }
        const riskClass = picker.pick(i);
        const row = generator.generate(riskClass);
        await producer.add(row);
      }
      await producer.flush();
      await producer.close();
    } catch (err) {
      try { await producer.close(); } catch { /* swallow flush-on-close error */ }
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.warn({ evt: "generator-start", run_id, err: msg });
        reply.code(translated.status);
        return translated.body;
      }
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ evt: "generator-start", run_id, err: msg });
      reply.code(502);
      return { error: `redis unreachable: ${msg}` };
    }

    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows_queued = producer.rowsSent;
    app.log.info({ evt: "generator-start", run_id, rows_queued, classes: resolvedClasses, ms });

    return {
      ok: true,
      run_id,
      rows_queued,
      classes: resolvedClasses,
      sensitivity_types,
      ms: Math.round(ms * 1000) / 1000,
      stop_reason: stopReason,
    };
  });

  // Wave 5.40a — streaming variant. The generation loop runs as a DETACHED
  // promise that owns the lifecycle of an `activeRuns` entry; the SSE handler
  // is a pure transport that pipes state into frames and stops writing on
  // client disconnect WITHOUT cancelling the run (refresh-survival, see Wave
  // 5.40 spec). Cancellation only happens via POST /generator/cancel/:run_id
  // or via a producer/redis error.
  const progressIntervalMs = opts.sseProgressIntervalMs ?? 200;
  const terminalGraceMs = opts.terminalGraceMs ?? 30_000;

  // Detached generator loop. Mutates `state` in place; resolves when the run
  // reaches a terminal status (done/cancelled/error). Never throws.
  const runGenerator = async (
    state: ActiveRun,
    t0: bigint,
    rows: number,
    picker: ClassPicker,
    generator: ReturnType<typeof createRowGenerator>,
    producer: ReturnType<typeof createStreamProducer>,
    target_label: string,
    stopWhen: StopWhen,
    redis: RedisLike,
  ): Promise<void> => {
    const tick = (): void => {
      state.rows_done = producer.rowsSent;
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      state.elapsed_ms = Math.round(elapsed);
      state.rows_per_sec = elapsed > 0 ? Math.round((state.rows_done / elapsed) * 1000) : 0;
    };
    // Wave 5.47c — stop-condition bookkeeping. `loopReason` records which
    // active stop condition broke the loop; default is "rows" (ran to count).
    let loopReason: StopReason = "rows";
    const startedAtMs = Date.now();
    let lastMemPollBatchCount = 0;
    let lastMemPollAtMs = startedAtMs;
    try {
      for (let i = 0; i < rows; i++) {
        if (state.cancelFlag.cancelled) break;
        // Wave 5.47c — check active stop conditions before each row so the
        // terminal frame surfaces stop_reason at the row count when tripped.
        if (stopWhen.elapsed_seconds !== undefined
          && (Date.now() - startedAtMs) / 1000 >= stopWhen.elapsed_seconds) {
          loopReason = "elapsed";
          break;
        }
        if (stopWhen.memory_pct !== undefined) {
          const dueByBatches = producer.batchCount - lastMemPollBatchCount >= 25;
          const dueByTime = Date.now() - lastMemPollAtMs >= 1000;
          if (dueByBatches && dueByTime) {
            lastMemPollBatchCount = producer.batchCount;
            lastMemPollAtMs = Date.now();
            try {
              const text = await redis.info("memory");
              const pct = memoryPct(parseInfoMemory(text));
              if (pct !== null && pct >= stopWhen.memory_pct) {
                loopReason = "memory";
                break;
              }
            } catch { /* tolerate transient INFO failure; next poll retries */ }
          }
        }
        const riskClass = picker.pick(i);
        const row = generator.generate(riskClass);
        await producer.add(row);
        tick();
      }
      await producer.flush();
      await producer.close();
      tick();
    } catch (err) {
      try { await producer.close(); } catch { /* swallow flush-on-close error */ }
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ evt: "generator-stream", run_id: state.run_id, err: msg });
      const errBody = translated
        ? translated.body
        : { error: `redis unreachable: ${msg}` };
      state.error = (errBody as { error?: string }).error ?? "redis error";
      tick();
    }
    if (state.error) {
      state.status = "error";
      state.stop_reason = "error";
    } else if (state.cancelFlag.cancelled) {
      state.status = "cancelled";
      state.stop_reason = "cancelled";
    } else {
      state.status = "done";
      state.stop_reason = loopReason;
    }
    state.terminal_at_ms = Date.now();
  };

  app.post<{ Body: GeneratorStartBody }>("/generator/start/stream", async (req, reply) => {
    if (!schema) {
      app.log.warn({ evt: "generator-stream", err: "schema-missing" });
      reply.code(503);
      return { error: "schema not loaded; api boot incomplete" };
    }

    const body = (req.body ?? {}) as GeneratorStartBody;
    const parsed = parseGeneratorRequest(body, schema);
    if (!parsed.ok) {
      reply.code(parsed.status);
      return { error: parsed.error };
    }
    const { rows, resolvedClasses, sensitivity_types, tradePool, factorPool, picker, stopWhen, batchSize, pipelineWindow } = parsed;

    const run_id = ulid();
    const t0 = process.hrtime.bigint();
    const redis = getRedis();
    const target_label = getActiveTarget().label;

    const state: ActiveRun = {
      run_id,
      status: "running",
      rows_done: 0,
      rows_total: rows,
      elapsed_ms: 0,
      rows_per_sec: 0,
      started_at_iso: new Date().toISOString(),
      classes: resolvedClasses,
      sensitivity_types,
      cancelFlag: { cancelled: false },
    };
    activeRuns.set(run_id, state);

    // Open the SSE channel before kicking off generation so the client
    // immediately sees `run_id` in the first progress frame.
    const cors = corsHeadersForRequest(req, corsAllowed);
    reply.raw.writeHead(200, {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.hijack();

    // Wave 5.40a — client disconnect (browser refresh, tab close, network
    // drop) ONLY stops writing SSE frames. The run continues server-side and
    // the client recovers via GET /generator/runs/:id/status.
    let clientConnected = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopWriting = (): void => {
      if (!clientConnected) return;
      clientConnected = false;
      if (interval) { clearInterval(interval); interval = null; }
    };
    reply.raw.on("close", stopWriting);
    reply.raw.on("error", stopWriting);

    const writeFrame = (obj: unknown): void => {
      if (!clientConnected) return;
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); }
      catch { stopWriting(); }
    };
    // Seed frame so the client has the run_id even when generation completes
    // before the first interval tick (small synthetic batches).
    writeFrame({ run_id, rows_done: 0, rows_total: rows, elapsed_ms: 0, rows_per_sec: 0 });

    const emitProgress = (): void => {
      if (!clientConnected) return;
      if (state.status !== "running") return;
      writeFrame({
        run_id,
        rows_done: state.rows_done,
        rows_total: rows,
        elapsed_ms: state.elapsed_ms,
        rows_per_sec: state.rows_per_sec,
      });
    };
    interval = setInterval(emitProgress, progressIntervalMs);

    const generator = createRowGenerator(schema, {
      seed: body.seed,
      sensitivityTypes: sensitivity_types,
      tradePoolSize: tradePool,
      factorPoolSize: factorPool,
    });
    const producer = createStreamProducer(
      redis as unknown as Parameters<typeof createStreamProducer>[0],
      { stream: streamName, batchSize: 200 },
    );

    // Detached run — handle terminal frame + grace-eviction here so the
    // route handler can return immediately after writing the seed frame.
    void runGenerator(state, t0, rows, picker, generator, producer, target_label, stopWhen, redis)
      .then(() => {
        if (interval) { clearInterval(interval); interval = null; }
        const msPrecise = Math.round(state.elapsed_ms * 1000) / 1000;
        const cancelled = state.status === "cancelled";
        const terminalFrame: Record<string, unknown> = {
          run_id,
          done: true,
          rows_queued: state.rows_done,
          ms: msPrecise,
          cancelled,
          // Wave 5.47c — additive terminal-frame field. Existing
          // done/cancelled/error flags are preserved for backward compat.
          stop_reason: state.stop_reason ?? (state.error ? "error" : cancelled ? "cancelled" : "rows"),
        };
        if (state.error) terminalFrame.error = state.error;
        if (clientConnected) {
          try { reply.raw.write(`data: ${JSON.stringify(terminalFrame)}\n\n`); } catch { /* socket gone */ }
          try { reply.raw.end(); } catch { /* socket already closed */ }
          clientConnected = false;
        }
        if (!state.error) {
          app.log.info({ evt: "generator-stream", run_id, rows_queued: state.rows_done, cancelled, classes: resolvedClasses, ms: state.elapsed_ms });
        }
        // Grace-eviction: keep the entry around for late-arriving clients
        // (refresh right after completion) so /runs/:id/status still works.
        setTimeout(() => { activeRuns.delete(run_id); }, terminalGraceMs).unref?.();
      })
      .catch((err: unknown) => {
        // Defensive: runGenerator catches all producer errors internally, so
        // this should never fire. Log + force-evict so a stuck entry can't
        // linger in `activeRuns`.
        const msg = err instanceof Error ? err.message : String(err);
        app.log.error({ evt: "generator-stream", run_id, err: msg, stage: "detached" });
        state.status = "error";
        state.error = msg;
        state.terminal_at_ms = Date.now();
        if (interval) { clearInterval(interval); interval = null; }
        if (clientConnected) {
          try { reply.raw.end(); } catch { /* */ }
          clientConnected = false;
        }
        setTimeout(() => { activeRuns.delete(run_id); }, terminalGraceMs).unref?.();
      });
  });

  // Wave 5.40a — status endpoint for a single run. Returns the public slice
  // of ActiveRun (no cancelFlag internals). 404 if the run is unknown OR has
  // already been grace-evicted.
  app.get<{ Params: { id: string } }>("/generator/runs/:id/status", async (req, reply) => {
    const id = req.params.id;
    const entry = activeRuns.get(id);
    if (!entry) {
      reply.code(404);
      return { error: "unknown run_id" };
    }
    return {
      run_id: entry.run_id,
      status: entry.status,
      rows_done: entry.rows_done,
      rows_total: entry.rows_total,
      rows_per_sec: entry.rows_per_sec,
      elapsed_ms: entry.elapsed_ms,
      started_at_iso: entry.started_at_iso,
      classes: entry.classes,
      sensitivity_types: entry.sensitivity_types,
      ...(entry.error ? { error: entry.error } : {}),
      // Wave 5.47c — surface the resolved stop_reason on terminal entries so
      // late-arriving clients (post-refresh) can render the same label as
      // the SSE terminal frame.
      ...(entry.stop_reason ? { stop_reason: entry.stop_reason } : {}),
    };
  });

  // Wave 5.40a — orphan-discovery endpoint. The UI hits this on mount to
  // adopt runs whose SSE stream died across a refresh.
  app.get("/generator/runs", async () => {
    const active: Array<{ run_id: string; status: string; rows_done: number; rows_total: number }> = [];
    for (const entry of activeRuns.values()) {
      if (entry.status === "running") {
        active.push({
          run_id: entry.run_id,
          status: entry.status,
          rows_done: entry.rows_done,
          rows_total: entry.rows_total,
        });
      }
    }
    return { active };
  });

  // Wave 5.20c — cancel a streaming run by id. Flips the cancel flag; the
  // detached generation loop notices at the next row boundary, drains the
  // in-flight batch, and transitions to terminal status "cancelled".
  app.post<{ Params: { run_id: string } }>("/generator/cancel/:run_id", async (req, reply) => {
    const id = req.params.run_id;
    const entry = activeRuns.get(id);
    if (!entry) {
      reply.code(404);
      return { ok: false, error: "unknown run_id" };
    }
    entry.cancelFlag.cancelled = true;
    return { ok: true, cancelled: true, run_id: id };
  });

  // Wave 5.44 — admin "stop all runs" escape hatch. Iterates `activeRuns`
  // and flips the cancel flag on every entry currently `status === "running"`
  // whose flag isn't already set. Idempotent: a follow-up call returns
  // cancelled:0 because the previous call already marked the flags. No body
  // required — Fastify accepts an empty POST and we never read req.body.
  app.post("/admin/cancel-all-runs", async () => {
    const run_ids: string[] = [];
    for (const entry of activeRuns.values()) {
      if (entry.status === "running" && !entry.cancelFlag.cancelled) {
        entry.cancelFlag.cancelled = true;
        run_ids.push(entry.run_id);
      }
    }
    return { ok: true, cancelled: run_ids.length, run_ids };
  });
}

// Wave 5.44 — test-only accessors for the module-local activeRuns registry.
// Mirrors the resetBootstrapStatusForTests pattern in server.ts. Production
// code paths never touch these.
export interface TestActiveRun {
  run_id: string;
  status: "running" | "done" | "cancelled" | "error";
  cancelFlag: { cancelled: boolean };
}
export function _testInsertActiveRun(run: TestActiveRun): void {
  activeRuns.set(run.run_id, {
    run_id: run.run_id,
    status: run.status,
    rows_done: 0,
    rows_total: 0,
    elapsed_ms: 0,
    rows_per_sec: 0,
    started_at_iso: new Date().toISOString(),
    classes: [],
    sensitivity_types: [],
    cancelFlag: run.cancelFlag,
  });
}
export function _testGetActiveRun(run_id: string): TestActiveRun | undefined {
  const e = activeRuns.get(run_id);
  if (!e) return undefined;
  return { run_id: e.run_id, status: e.status, cancelFlag: e.cancelFlag };
}
export function _testResetActiveRuns(): void {
  activeRuns.clear();
}

// PipelineClient is exported for the test stub to keep its mock shape aligned
// with what createStreamProducer actually invokes.
export type { PipelineClient };
