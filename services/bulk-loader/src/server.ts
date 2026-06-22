// Wave 7.0.1.A / 7.0.1.B / 7.0.1.C — bulk-loader HTTP control surface.
//
//   GET  /healthz        → 200 iff pool isHealthy() (≥75% workers connected).
//   GET  /load/status    → pool size, connected count, per-worker pool state
//                          + dispatcher in-flight / per-worker write metrics
//                          (queued, flushed, errors, retries, dead-lettered,
//                          last_flush_latency_ms) when a dispatcher is wired.
//   POST /load/start     → toggles accepting=true (idempotent). Returns 202
//                          with the current accepting state.
//   POST /load/stop      → toggles accepting=false; subsequent /load/rows
//                          requests are rejected with 503. Returns 202.
//   POST /load/rows      → 7.0.1.C row sink. Accepts NDJSON
//                          (`application/x-ndjson`) or JSON-array
//                          (`application/json`) bodies, enqueues each row
//                          into the 7.0.1.B dispatcher. 202 on accept,
//                          429 when in-flight ≥ highWater (producer-side
//                          backpressure), 503 when not accepting, 400 on
//                          malformed body, 5xx on dispatcher failure.

import Fastify, { type FastifyInstance } from "fastify";
import type { WorkerPool } from "./pool.ts";
import type { DispatcherHandle, Row } from "./dispatcher.ts";
import type { CheckpointRecord } from "./checkpoint.ts";

export interface CreateServerOpts {
  pool: WorkerPool;
  dispatcher?: DispatcherHandle;
  logger?: boolean;
  // Wave 7.0.1.C — initial accepting state. Defaults to true so a freshly
  // booted bulk-loader is ready to ingest without an explicit /load/start.
  // /load/start and /load/stop flip this at runtime.
  accepting?: boolean;
  // Wave 7.0.5.A — bootstrap checkpoints loaded from Redis at boot. Used by
  // /load/checkpoints to surface the resume watermark to a freshly-spawned
  // generator before the in-process workers have written anything new.
  bootstrapCheckpoints?: ReadonlyMap<number, CheckpointRecord>;
  // Wave 7.0.5.A — structured-log sink so /load/rows body-parse errors are
  // visible to operators instead of being silently swallowed into the 400
  // response. Increments the body_drain_errors counter surfaced by
  // /load/status when invoked.
  logEvent?: (level: "warn" | "info", obj: object, msg: string) => void;
}

export async function createServer(opts: CreateServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  // Wave 7.0.1.C — NDJSON content-type parser. We keep the raw string and
  // split on newlines below so single-line JSON-arrays sent with the wrong
  // content-type still parse, and so a trailing newline is tolerated.
  app.addContentTypeParser(
    "application/x-ndjson",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  let accepting = opts.accepting !== false;
  // Wave 7.0.5.A — observable counter of /load/rows body-parse failures.
  // Surfaced via /load/status so operators can detect malformed-producer
  // traffic that the old code path discarded into a 400 with no signal.
  let bodyDrainErrors = 0;
  const bootstrapCheckpoints = opts.bootstrapCheckpoints ?? new Map<number, CheckpointRecord>();

  app.get("/healthz", async (_req, reply) => {
    const s = opts.pool.status();
    const healthy = opts.pool.isHealthy();
    reply.code(healthy ? 200 : 503);
    return {
      service: "bulk-loader",
      status: healthy ? "ok" : "degraded",
      connected: s.connected,
      pool_size: s.poolSize,
    };
  });

  app.get("/load/status", async () => {
    const s = opts.pool.status();
    // Wave 7.0.1.B — merge per-worker write metrics onto each pool worker
    // entry so operators see a single combined view. last_flush_at is
    // sourced from the dispatcher (the actual flush timestamp) when present.
    const d = opts.dispatcher?.status();
    const dispatcherMetricsById = new Map<number, ReturnType<DispatcherHandle["status"]>["workers"][number]>();
    if (d) {
      for (const m of d.workers) dispatcherMetricsById.set(m.id, m);
    }
    const workers = s.workers.map((w) => {
      const m = dispatcherMetricsById.get(w.id);
      return {
        ...w,
        last_flush_at: m?.lastFlushAt ?? w.last_flush_at,
        queued: m?.queued ?? null,
        flushed: m?.flushed ?? null,
        errors: m?.errors ?? null,
        retries: m?.retries ?? null,
        dead_lettered: m?.deadLettered ?? null,
        last_flush_latency_ms: m?.lastFlushLatencyMs ?? null,
      };
    });
    return {
      pool_size: s.poolSize,
      connected: s.connected,
      dispatcher: d
        ? { in_flight: d.inFlight, high_water: d.highWater }
        : null,
      body_drain_errors: bodyDrainErrors,
      workers,
    };
  });

  // Wave 7.0.5.A — checkpoint snapshot. Merges any bootstrap checkpoints
  // loaded from Redis at boot with the live worker watermarks so a generator
  // restarted after a bulk-loader crash sees the persisted state and a
  // generator restarted mid-run sees the freshest in-process state.
  app.get("/load/checkpoints", async () => {
    const live = opts.dispatcher?.status().workers ?? [];
    const liveById = new Map<number, (typeof live)[number]>();
    for (const m of live) liveById.set(m.id, m);
    const ids = new Set<number>();
    for (const id of bootstrapCheckpoints.keys()) ids.add(id);
    for (const m of live) ids.add(m.id);
    const sorted = [...ids].sort((a, b) => a - b);
    const out: Array<{
      id: number;
      rows_written: number;
      last_ulid: string | null;
      last_updated: number | null;
      source: "live" | "bootstrap";
    }> = [];
    let resumeUlid: string | null = null;
    for (const id of sorted) {
      const liveM = liveById.get(id);
      const boot = bootstrapCheckpoints.get(id);
      // Live state supersedes bootstrap once the worker has flushed even
      // one row in the current process — its lastUlid is by construction
      // >= the persisted value.
      const liveActive = liveM && (liveM.lastUlid !== null || liveM.flushed > 0);
      if (liveActive && liveM) {
        out.push({
          id,
          rows_written: liveM.flushed,
          last_ulid: liveM.lastUlid,
          last_updated: liveM.lastFlushAt,
          source: "live",
        });
        if (liveM.lastUlid !== null && (resumeUlid === null || liveM.lastUlid > resumeUlid)) {
          resumeUlid = liveM.lastUlid;
        }
      } else if (boot) {
        out.push({
          id,
          rows_written: boot.rows_written,
          last_ulid: boot.last_ulid,
          last_updated: boot.last_updated,
          source: "bootstrap",
        });
        if (boot.last_ulid !== null && (resumeUlid === null || boot.last_ulid > resumeUlid)) {
          resumeUlid = boot.last_ulid;
        }
      } else if (liveM) {
        out.push({
          id,
          rows_written: liveM.flushed,
          last_ulid: liveM.lastUlid,
          last_updated: liveM.lastFlushAt,
          source: "live",
        });
      }
    }
    return { resume_ulid: resumeUlid, workers: out };
  });

  app.post("/load/start", async (_req, reply) => {
    // Wave 7.0.1.C — real lifecycle endpoint. Idempotently flips accepting
    // to true so producers can verify the bulk-loader is ready to ingest
    // before sending /load/rows traffic. The dispatcher is constructed at
    // boot; this endpoint does not (re)create it.
    accepting = true;
    reply.code(202);
    return { accepted: true, accepting };
  });

  app.post("/load/stop", async (_req, reply) => {
    // Wave 7.0.1.C — drain side of the lifecycle. Flips accepting to false
    // so subsequent /load/rows requests get 503. Already-queued rows
    // continue to flush through the dispatcher's worker buffers.
    accepting = false;
    reply.code(202);
    return { accepted: true, accepting };
  });

  app.post("/load/rows", async (req, reply) => {
    // Wave 7.0.1.C — row ingest entry point. The dispatcher is required;
    // an unwired server (no 7.0.1.B dispatcher) cannot accept rows.
    const d = opts.dispatcher;
    if (!d) {
      reply.code(503);
      return { accepted: 0, reason: "no dispatcher wired" };
    }
    if (!accepting) {
      reply.code(503);
      return { accepted: 0, reason: "bulk-loader not accepting (call /load/start)" };
    }
    let rows: Row[];
    try {
      rows = parseRowsBody(req.headers["content-type"], req.body);
    } catch (err) {
      // Wave 7.0.5.A — surface body-parse failures instead of silently
      // returning 400. The counter is reported via /load/status; the log
      // line carries the content-type so operators can distinguish a
      // misconfigured producer from a transient request-corruption bug.
      bodyDrainErrors++;
      const msg = (err as Error).message;
      opts.logEvent?.(
        "warn",
        {
          evt: "bulk-load-body-parse-error",
          content_type: req.headers["content-type"] ?? null,
          err: msg,
        },
        "bulk-loader /load/rows body parse failed",
      );
      reply.code(400);
      return { accepted: 0, reason: `malformed body: ${msg}` };
    }
    if (rows.length === 0) {
      reply.code(202);
      return { accepted: 0 };
    }
    // Producer-side backpressure signal: if the current snapshot is already
    // at or above the dispatcher's high-water mark, return 429 so the
    // generator's HTTP producer pauses with exponential-jitter backoff
    // (folded 7.0.5.B). This is the load-bearing knob — without it,
    // generator awaits would silently stall inside enqueue().
    const status = d.status();
    if (status.inFlight + rows.length > status.highWater) {
      reply.code(429);
      reply.header("retry-after", "1");
      return {
        accepted: 0,
        reason: "high-water exceeded",
        in_flight: status.inFlight,
        high_water: status.highWater,
      };
    }
    try {
      // Under highWater (checked above), enqueue resolves synchronously
      // — no await would block. We still await Promise.all so any
      // unexpected back-edge (concurrent producer racing past the snapshot)
      // surfaces here rather than as an unhandled-rejection.
      await Promise.all(rows.map((r) => d.enqueue(r)));
    } catch (err) {
      reply.code(500);
      return { accepted: 0, reason: `enqueue failed: ${(err as Error).message}` };
    }
    reply.code(202);
    return { accepted: rows.length };
  });

  return app;
}

// Wave 7.0.1.C — body parser shared by /load/rows. Accepts NDJSON (one
// JSON object per line, blank lines tolerated) or a JSON array. Strict on
// content-type so a misconfigured client (e.g. sending NDJSON as
// application/json) fails fast with a 400 rather than silently dropping
// the trailing rows after JSON.parse hits the first newline.
export function parseRowsBody(contentType: string | undefined, body: unknown): Row[] {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("application/x-ndjson")) {
    if (typeof body !== "string") {
      throw new Error("ndjson body must be a string");
    }
    const out: Row[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed);
      if (parsed == null || typeof parsed !== "object") {
        throw new Error("ndjson line is not a JSON object");
      }
      out.push(parsed as Row);
    }
    return out;
  }
  if (ct.startsWith("application/json")) {
    if (!Array.isArray(body)) {
      throw new Error("application/json body must be an array of rows");
    }
    return body as Row[];
  }
  throw new Error(
    `unsupported content-type: ${ct || "(missing)"} — expected application/x-ndjson or application/json`,
  );
}
