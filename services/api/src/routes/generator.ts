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
}

const DEFAULT_ROWS = 200;
const DEFAULT_CLASSES = ["GIRR", "Equity", "FX"] as const;
const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega"] as const;

// Wave 5.20c — module-local registry of in-flight streaming runs. The cancel
// endpoint and client-disconnect handler flip `cancelFlag.cancelled`; the
// generation loop checks the flag at each row boundary and exits cleanly,
// emitting a terminal frame with `cancelled: true`. Entries are evicted when
// the run completes or is cancelled.
interface ActiveRun { cancelFlag: { cancelled: boolean } }
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

  // Wave 5.20c — streaming variant that emits SSE progress frames every
  // ~progressIntervalMs and a terminal completion frame. Same body shape as
  // /generator/start; mirrors the setInterval-driven writer in
  // observability.ts /observability/shards/stream.
  const progressIntervalMs = opts.sseProgressIntervalMs ?? 200;
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
    const cancelFlag = { cancelled: false };
    activeRuns.set(run_id, { cancelFlag });

    const t0 = process.hrtime.bigint();
    const redis = getRedis();
    const target_label = getActiveTarget().label;

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

    // Client-disconnect halts the run server-side (closing the browser tab,
    // network drop, AbortController on the UI side). Listen on `reply.raw`
    // (the response socket) — `req.raw` fires `close` as soon as Fastify
    // finishes consuming the inbound JSON body, which would flip the cancel
    // flag before the generation loop even starts.
    const onClose = (): void => { cancelFlag.cancelled = true; };
    reply.raw.on("close", onClose);
    reply.raw.on("error", onClose);

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

    const writeFrame = (obj: unknown): void => {
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); }
      catch { cancelFlag.cancelled = true; }
    };
    // Seed frame so the client has the run_id even when generation completes
    // before the first interval tick (small synthetic batches).
    writeFrame({ run_id, rows_done: 0, rows_total: rows, elapsed_ms: 0, rows_per_sec: 0 });

    const emitProgress = (): void => {
      if (cancelFlag.cancelled) return;
      const rows_done = producer.rowsSent;
      const elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const rows_per_sec = elapsed_ms > 0 ? Math.round((rows_done / elapsed_ms) * 1000) : 0;
      writeFrame({
        run_id,
        rows_done,
        rows_total: rows,
        elapsed_ms: Math.round(elapsed_ms),
        rows_per_sec,
      });
    };
    const interval = setInterval(emitProgress, progressIntervalMs);

    let errBody: { status: number; body: unknown } | null = null;
    try {
      for (let i = 0; i < rows; i++) {
        if (cancelFlag.cancelled) break;
        const riskClass = resolvedClasses[i % resolvedClasses.length]!;
        const row = generator.generate(riskClass);
        await producer.add(row);
      }
      await producer.flush();
      await producer.close();
    } catch (err) {
      try { await producer.close(); } catch { /* swallow flush-on-close error */ }
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ evt: "generator-stream", run_id, err: msg });
      errBody = translated
        ? { status: translated.status, body: translated.body }
        : { status: 502, body: { error: `redis unreachable: ${msg}` } };
    }

    clearInterval(interval);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows_queued = producer.rowsSent;
    const cancelled = cancelFlag.cancelled;
    if (errBody) {
      writeFrame({ run_id, done: true, rows_queued, ms: Math.round(ms * 1000) / 1000, cancelled, error: (errBody.body as { error?: string }).error ?? "redis error" });
    } else {
      writeFrame({ run_id, done: true, rows_queued, ms: Math.round(ms * 1000) / 1000, cancelled });
      app.log.info({ evt: "generator-stream", run_id, rows_queued, cancelled, classes: resolvedClasses, ms });
    }
    try { reply.raw.end(); } catch { /* socket already closed */ }
    activeRuns.delete(run_id);
  });

  // Wave 5.20c — cancel a streaming run by id. Flips the cancel flag; the
  // generation loop notices at the next row boundary, drains the in-flight
  // batch, and emits a terminal frame with `cancelled: true`.
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
}

// PipelineClient is exported for the test stub to keep its mock shape aligned
// with what createStreamProducer actually invokes.
export type { PipelineClient };
