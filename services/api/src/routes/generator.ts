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
}

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
    const rows = body.rows ?? DEFAULT_ROWS;
    // Wave 5.20c — hard MAX_ROWS cap removed; the cluster sanity check
    // (services/ui/src/panels/IngestPanel.tsx computeSanity) is the
    // user-facing guardrail. Only structural validation remains here.
    if (
      typeof rows !== "number"
      || !Number.isFinite(rows)
      || !Number.isInteger(rows)
      || rows <= 0
      || rows > Number.MAX_SAFE_INTEGER
    ) {
      reply.code(400);
      return { error: "rows must be a positive integer" };
    }

    const classes = body.classes && body.classes.length > 0
      ? body.classes
      : [...DEFAULT_CLASSES];
    for (const c of classes) {
      const upper = String(c).toUpperCase();
      if (!schema.risk_classes[upper] && !schema.risk_classes[c]) {
        reply.code(400);
        return { error: `unknown risk class: ${c}` };
      }
    }
    // Resolve to the canonical key (UPPERCASE) used everywhere downstream —
    // mirrors the calc.ts §Wave 5.15l convention.
    const resolvedClasses = classes.map((c) => {
      const upper = String(c).toUpperCase();
      return schema.risk_classes[upper] ? upper : c;
    });

    const sensitivity_types = body.sensitivity_types && body.sensitivity_types.length > 0
      ? body.sensitivity_types
      : [...DEFAULT_SENSITIVITY_TYPES];

    const run_id = ulid();
    const t0 = process.hrtime.bigint();

    // Wave 5.16t — resolve active redis per-request so the generator writes
    // to the currently-active profile's stream.
    const redis = getRedis();
    const target_label = getActiveTarget().label;

    // Wave 5.17a — validate pool sizes if provided (1..10000 / 1..256).
    const tradePool = body.trade_pool_size;
    if (tradePool !== undefined) {
      if (typeof tradePool !== "number" || !Number.isFinite(tradePool) || tradePool < 1 || tradePool > 10000) {
        reply.code(400);
        return { error: "trade_pool_size must be a number in 1..10000" };
      }
    }
    const factorPool = body.factor_pool_size;
    if (factorPool !== undefined) {
      if (typeof factorPool !== "number" || !Number.isFinite(factorPool) || factorPool < 1 || factorPool > 256) {
        reply.code(400);
        return { error: "factor_pool_size must be a number in 1..256" };
      }
    }

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

    try {
      for (let i = 0; i < rows; i++) {
        const riskClass = resolvedClasses[i % resolvedClasses.length]!;
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
    resolvedClasses: string[],
    generator: ReturnType<typeof createRowGenerator>,
    producer: ReturnType<typeof createStreamProducer>,
    target_label: string,
  ): Promise<void> => {
    const tick = (): void => {
      state.rows_done = producer.rowsSent;
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      state.elapsed_ms = Math.round(elapsed);
      state.rows_per_sec = elapsed > 0 ? Math.round((state.rows_done / elapsed) * 1000) : 0;
    };
    try {
      for (let i = 0; i < rows; i++) {
        if (state.cancelFlag.cancelled) break;
        const riskClass = resolvedClasses[i % resolvedClasses.length]!;
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
    if (state.error) state.status = "error";
    else if (state.cancelFlag.cancelled) state.status = "cancelled";
    else state.status = "done";
    state.terminal_at_ms = Date.now();
  };

  app.post<{ Body: GeneratorStartBody }>("/generator/start/stream", async (req, reply) => {
    if (!schema) {
      app.log.warn({ evt: "generator-stream", err: "schema-missing" });
      reply.code(503);
      return { error: "schema not loaded; api boot incomplete" };
    }

    const body = (req.body ?? {}) as GeneratorStartBody;
    const rows = body.rows ?? DEFAULT_ROWS;
    if (
      typeof rows !== "number"
      || !Number.isFinite(rows)
      || !Number.isInteger(rows)
      || rows <= 0
      || rows > Number.MAX_SAFE_INTEGER
    ) {
      reply.code(400);
      return { error: "rows must be a positive integer" };
    }

    const classes = body.classes && body.classes.length > 0
      ? body.classes
      : [...DEFAULT_CLASSES];
    for (const c of classes) {
      const upper = String(c).toUpperCase();
      if (!schema.risk_classes[upper] && !schema.risk_classes[c]) {
        reply.code(400);
        return { error: `unknown risk class: ${c}` };
      }
    }
    const resolvedClasses = classes.map((c) => {
      const upper = String(c).toUpperCase();
      return schema.risk_classes[upper] ? upper : c;
    });

    const sensitivity_types = body.sensitivity_types && body.sensitivity_types.length > 0
      ? body.sensitivity_types
      : [...DEFAULT_SENSITIVITY_TYPES];

    const tradePool = body.trade_pool_size;
    if (tradePool !== undefined) {
      if (typeof tradePool !== "number" || !Number.isFinite(tradePool) || tradePool < 1 || tradePool > 10000) {
        reply.code(400);
        return { error: "trade_pool_size must be a number in 1..10000" };
      }
    }
    const factorPool = body.factor_pool_size;
    if (factorPool !== undefined) {
      if (typeof factorPool !== "number" || !Number.isFinite(factorPool) || factorPool < 1 || factorPool > 256) {
        reply.code(400);
        return { error: "factor_pool_size must be a number in 1..256" };
      }
    }

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
    void runGenerator(state, t0, rows, resolvedClasses, generator, producer, target_label)
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
