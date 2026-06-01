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

interface GeneratorStartBody {
  rows?: number;
  classes?: string[];
  sensitivity_types?: string[];
  seed?: string | number;
}

export interface GeneratorRoutesOpts {
  streamName?: string;
}

const DEFAULT_ROWS = 200;
const MAX_ROWS = 2000;
const DEFAULT_CLASSES = ["GIRR", "Equity", "FX"] as const;
const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega"] as const;

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

  app.post<{ Body: GeneratorStartBody }>("/generator/start", async (req, reply) => {
    if (!schema) {
      app.log.warn({ evt: "generator-start", err: "schema-missing" });
      reply.code(503);
      return { error: "schema not loaded; api boot incomplete" };
    }

    const body = (req.body ?? {}) as GeneratorStartBody;
    const rows = body.rows ?? DEFAULT_ROWS;
    if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) {
      reply.code(400);
      return { error: "rows must be a positive number" };
    }
    if (rows > MAX_ROWS) {
      reply.code(400);
      return { error: `rows must be ≤ ${MAX_ROWS} per request` };
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

    const generator = createRowGenerator(schema, {
      seed: body.seed,
      sensitivityTypes: sensitivity_types,
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
}

// PipelineClient is exported for the test stub to keep its mock shape aligned
// with what createStreamProducer actually invokes.
export type { PipelineClient };
