// Wave 7.0.1.A / 7.0.1.B / 7.0.1.C — bulk-loader HTTP control surface.
//
//   GET  /healthz        → 200 liveness (process up; status=awaiting before Redis
//                          is configured via UI). Pool health on /load/status.
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
import { createBulkLoaderState, type BulkLoaderState } from "./swap-target.ts";

export interface CreateServerOpts {
  // Wave 7.0.6.17 — preferred: pass a `state` holder so the active-target
  // watcher can atomically swap the pool/dispatcher/checkpointer references
  // under the live HTTP listener. Legacy callers (existing tests) may still
  // pass `pool` + `dispatcher` directly; a default state is constructed.
  state?: BulkLoaderState;
  pool?: WorkerPool;
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
  // Wave 7.0.6.17 — every request reads pool / dispatcher / bootstrap
  // checkpoints THROUGH `state`. swapTarget mutates these fields in place,
  // so a /load/rows that arrives mid-swap sees the new pool the moment the
  // swap completes, and an accepting=false flipped at the top of swapTarget
  // surfaces immediately as a 503.
  const state: BulkLoaderState = opts.state ?? createBulkLoaderState({
    pool: opts.pool ?? throwMissingPool(),
    dispatcher: opts.dispatcher ?? null,
    checkpointer: null,
    bootstrapCheckpoints: opts.bootstrapCheckpoints ?? new Map<number, CheckpointRecord>(),
    // No identity available to legacy callers; surface zero-values so
    // /load/status still parses but the UI banner just shows blanks.
    boundTarget: { host: "", port: 0, label: "" },
    boundVersion: null,
    targetWatcher: "disabled",
    accepting: opts.accepting,
  });
  const app = Fastify({ logger: opts.logger ?? false });
  // Wave 7.0.1.C — NDJSON content-type parser. We keep the raw string and
  // split on newlines below so single-line JSON-arrays sent with the wrong
  // content-type still parse, and so a trailing newline is tolerated.
  app.addContentTypeParser(
    "application/x-ndjson",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  // Wave 7.0.5.A — observable counter of /load/rows body-parse failures.
  // Surfaced via /load/status so operators can detect malformed-producer
  // traffic that the old code path discarded into a 400 with no signal.
  let bodyDrainErrors = 0;

  // Wave 7.0.6.22 — rolling 10s window of 429 emit timestamps. Drives the
  // `recent_429_count` / `throttled` fields on /load/status so the UI's
  // rate-gauge can light up the "throttled" indicator during sustained
  // backpressure and dim it once the window clears.
  //
  // Plain array (not a ring buffer) is fine here: cardinality is bounded
  // by the highest sustainable 429/sec on this process — at typical
  // 100rps it's <1k entries, trimmed lazily on each /load/status read.
  const recent429: number[] = [];
  const RECENT_429_WINDOW_MS = 10_000;
  function record429Now(): void {
    recent429.push(Date.now());
  }
  function trimRecent429(now: number): void {
    const cutoff = now - RECENT_429_WINDOW_MS;
    // Indices are append-only-ascending; binary-search would help if this
    // ever became hot. At <1k entries a linear shift from the front is
    // perfectly fine and avoids the extra allocation a slice() would do.
    let drop = 0;
    while (drop < recent429.length && recent429[drop]! < cutoff) drop++;
    if (drop > 0) recent429.splice(0, drop);
  }

  app.get("/healthz", async (_req, reply) => {
    // Wave 7.0.6.25 / 7.0.8 — liveness: process is up even while awaiting a
    // UI-configured Redis target. Readiness (pool connected) is on /load/status.
    if (!state.pool) {
      return {
        service: "bulk-loader",
        status: "awaiting",
        connected: 0,
        pool_size: 0,
        reason: "awaiting Redis target configuration",
      };
    }
    const s = state.pool.status();
    const healthy = state.pool.isHealthy();
    // Wave 7.0.6.17 — fail-loud on stale target only. Connectivity degradation
    // (pool not yet connected) stays 200 liveness so compose --wait passes
    // before the operator activates a reachable target in the UI.
    if (state.targetStale) {
      reply.code(503);
      return {
        service: "bulk-loader",
        status: "degraded",
        connected: s.connected,
        pool_size: s.poolSize,
        target_stale: true,
        reason: state.targetStaleReason ?? "stale target",
      };
    }
    return {
      service: "bulk-loader",
      status: healthy ? "ok" : "degraded",
      connected: s.connected,
      pool_size: s.poolSize,
      ...(healthy ? {} : { reason: "redis pool not ready — check Connections target" }),
    };
  });

  app.get("/load/status", async () => {
    // Wave 7.0.6.25 — when state.pool is null (awaiting_target), return a
    // minimal status response with bound_target: null and empty workers array.
    // The UI banner + operator tools use this to detect the awaiting state.
    if (!state.pool) {
      return {
        pool_size: 0,
        connected: 0,
        dispatcher: null,
        throttled: false,
        headroom_pct: null,
        recent_429_count: 0,
        body_drain_errors: bodyDrainErrors,
        bound_target: null,
        target_stale: state.targetStale,
        target_stale_reason: state.targetStaleReason,
        api_active_target: state.apiActiveTarget ? { ...state.apiActiveTarget } : null,
        target_swap_count: state.targetSwapCount,
        last_swap_error: state.lastSwapError,
        target_watcher: state.targetWatcher,
        accepting: state.accepting,
        oom_rejected_total: 0,
        seen_sadds_emitted: 0,
        seen_sadds_failed: 0,
        workers: [],
        checkpoints: [],
      };
    }

    const s = state.pool.status();
    // Wave 7.0.1.B — merge per-worker write metrics onto each pool worker
    // entry so operators see a single combined view. last_flush_at is
    // sourced from the dispatcher (the actual flush timestamp) when present.
    const d = state.dispatcher?.status();
    const dispatcherMetricsById = new Map<number, ReturnType<DispatcherHandle["status"]>["workers"][number]>();
    if (d) {
      for (const m of d.workers) dispatcherMetricsById.set(m.id, m);
    }
    let oomTotal = 0;
    let seenSaddsEmittedTotal = 0;
    let seenSaddsFailedTotal = 0;
    const workers = s.workers.map((w) => {
      const m = dispatcherMetricsById.get(w.id);
      const oom = m?.oomRejected ?? 0;
      const saddsEmitted = m?.seenSaddsEmitted ?? 0;
      const saddsFailed = m?.seenSaddsFailed ?? 0;
      oomTotal += oom;
      seenSaddsEmittedTotal += saddsEmitted;
      seenSaddsFailedTotal += saddsFailed;
      return {
        ...w,
        last_flush_at: m?.lastFlushAt ?? w.last_flush_at,
        queued: m?.queued ?? null,
        flushed: m?.flushed ?? null,
        errors: m?.errors ?? null,
        retries: m?.retries ?? null,
        dead_lettered: m?.deadLettered ?? null,
        last_flush_latency_ms: m?.lastFlushLatencyMs ?? null,
        // Wave 7.0.6.17 — additive per-worker OOM counter. Null when no
        // dispatcher is wired so the existing null-for-all-metrics contract
        // holds; integer (possibly zero) when wired.
        oom_rejected: m ? oom : null,
        // Wave 7.0.6.13a — per-worker seen-set SADD counters. Null when no
        // dispatcher is wired so the existing null-for-all-metrics contract
        // holds; integer (possibly zero) when wired.
        seen_sadds_emitted: m ? saddsEmitted : null,
        seen_sadds_failed: m ? saddsFailed : null,
      };
    });
    // Wave 7.0.6.22 — backpressure surface for the UI rate-gauge.
    //   headroom_pct      ∈ [0,1] free capacity left in the dispatcher
    //                     queue. 0 ⇒ next request will 429. Null when no
    //                     dispatcher is wired (matches the legacy contract).
    //   recent_429_count  count of 429 responses emitted in the last 10s.
    //   throttled         derived: recent_429_count > 0 OR headroom_pct < 0.2.
    //                     The headroom-only branch lets the panel light up
    //                     proactively (within ~50ms of a sustained burst)
    //                     before the first 429 ships, instead of after.
    const nowMs = Date.now();
    trimRecent429(nowMs);
    const recent429Count = recent429.length;
    let headroomPct: number | null = null;
    if (d && d.highWater > 0) {
      headroomPct = Math.max(0, Math.min(1, 1 - d.inFlight / d.highWater));
    }
    const throttled = recent429Count > 0 || (headroomPct !== null && headroomPct < 0.2);
    return {
      pool_size: s.poolSize,
      connected: s.connected,
      dispatcher: d
        ? { in_flight: d.inFlight, high_water: d.highWater }
        : null,
      throttled,
      headroom_pct: headroomPct,
      recent_429_count: recent429Count,
      body_drain_errors: bodyDrainErrors,
      // Wave 7.0.6.17 / 7.0.6.25 — target identity + swap observability.
      // bound_target is null when in awaiting_target state.
      bound_target: state.boundTarget ? { ...state.boundTarget } : null,
      target_stale: state.targetStale,
      target_stale_reason: state.targetStaleReason,
      api_active_target: state.apiActiveTarget ? { ...state.apiActiveTarget } : null,
      target_swap_count: state.targetSwapCount,
      last_swap_error: state.lastSwapError,
      target_watcher: state.targetWatcher,
      accepting: state.accepting,
      oom_rejected_total: oomTotal,
      // Wave 7.0.6.13a — top-level sums of the per-worker seen-set SADD
      // counters. Operators / smoke harnesses read these to confirm the
      // bulk writer populated the discovery layer (`seen:risk_class` /
      // `seen:bucket:<rc>` / `seen:sens_type:<rc>:<bkt>`) calc dispatches
      // over via SMEMBERS.
      seen_sadds_emitted: seenSaddsEmittedTotal,
      seen_sadds_failed: seenSaddsFailedTotal,
      workers,
    };
  });

  // Wave 7.0.5.A — checkpoint snapshot. Merges any bootstrap checkpoints
  // loaded from Redis at boot with the live worker watermarks so a generator
  // restarted after a bulk-loader crash sees the persisted state and a
  // generator restarted mid-run sees the freshest in-process state.
  app.get("/load/checkpoints", async () => {
    const live = state.dispatcher?.status().workers ?? [];
    const liveById = new Map<number, (typeof live)[number]>();
    for (const m of live) liveById.set(m.id, m);
    const ids = new Set<number>();
    for (const id of state.bootstrapCheckpoints.keys()) ids.add(id);
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
      const boot = state.bootstrapCheckpoints.get(id);
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
    state.accepting = true;
    reply.code(202);
    return { accepted: true, accepting: state.accepting };
  });

  app.post("/load/stop", async (_req, reply) => {
    // Wave 7.0.1.C — drain side of the lifecycle. Flips accepting to false
    // so subsequent /load/rows requests get 503. Already-queued rows
    // continue to flush through the dispatcher's worker buffers.
    state.accepting = false;
    reply.code(202);
    return { accepted: true, accepting: state.accepting };
  });

  app.post("/load/rows", async (req, reply) => {
    // Wave 7.0.1.C — row ingest entry point. The dispatcher is required;
    // an unwired server (no 7.0.1.B dispatcher) cannot accept rows.
    const d = state.dispatcher;
    if (!d) {
      reply.code(503);
      return { accepted: 0, reason: "no dispatcher wired" };
    }
    // Wave 7.0.6.17 — fail-loud on stale target. Refuse writes whenever
    // the bulk-loader is bound to a Redis target the api no longer
    // considers active AND the watcher cannot/has not reconciled. Checked
    // BEFORE the `accepting` flag so the operator-facing 503 reason names
    // the divergence instead of the generic "call /load/start".
    if (state.targetStale) {
      reply.code(503);
      return {
        accepted: 0,
        reason: state.targetStaleReason ?? "stale target",
      };
    }
    if (!state.accepting) {
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
      // Wave 7.0.6.22 — stamp the rolling-window observation BEFORE
      // emitting the response so a /load/status read on the SAME tick
      // sees the count tick up. Drives the UI's throttled indicator.
      record429Now();
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

function throwMissingPool(): never {
  throw new Error("createServer: opts.pool or opts.state is required");
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
