// Wave 6.12a — runtime mutable shard state + drain/respawn orchestration.
//
// Owns the live `(totalShards, assignment, multi)` triple that cli.ts used to
// hold as locals. The active-target watcher and the POST /ingest/shards
// control path both call `rebuild()` which drains the previous MultiConsumer
// then spawns a new one against the latest activeClient (captured by the
// supplied `spawn` closure). A single in-flight mutex serialises rebuilds —
// a concurrent POST surfaces as RebuildBusyError → 409.

import type http from "node:http";
import { parseShardAssignment, shardStreamKey } from "./sharding.ts";
import type { MultiConsumer } from "./multi-consumer.ts";

export interface ShardRuntimeOptions {
  baseStream: string;
  initialTotalShards: number;
  initialAssignmentSpec: string;
  // Captures activeClient + GROUP + CONSUMER_NAME + BATCH_SIZE + BLOCK_MS +
  // schema from cli.ts so the runtime stays decoupled from those globals.
  spawn: (totalShards: number, assignment: readonly number[]) => Promise<MultiConsumer>;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  // Wave 6.32.A — hard cap on the drain+respawn sequence inside rebuild().
  // Falls back to INGEST_REBUILD_TIMEOUT_MS (read per-call) then 30 000 ms.
  rebuildTimeoutMs?: number;
}

export interface ShardSnapshot {
  totalShards: number;
  assignment: number[];
  streams: string[];
  // Wave 6.32.A — surfaced via GET /ingest/shards and GET /ingest/status so
  // operators / UI can see an in-flight rebuild. `rebuild_started_at` is only
  // present while `rebuilding` is true.
  rebuilding: boolean;
  rebuild_started_at?: string;
}

export interface HandleExtras {
  consumed: number;
  errors: number;
  ready: boolean;
}

export class RebuildBusyError extends Error {
  constructor() { super("rebuild already in progress"); this.name = "RebuildBusyError"; }
}

export class InvalidShardSpecError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidShardSpecError"; }
}

// Wave 6.32.A — thrown when `multi.stop()` or `opts.spawn()` exceed the
// configured budget. Mapped to HTTP 504 by the POST handler so the caller
// knows the in-flight rebuild was abandoned and a retry will be accepted.
export class RebuildTimeoutError extends Error {
  constructor(public readonly stage: string, public readonly timeoutMs: number) {
    super(`rebuild timed out at ${stage} after ${timeoutMs}ms`);
    this.name = "RebuildTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RebuildTimeoutError(label, ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface ShardRuntime {
  snapshot(): ShardSnapshot;
  getMulti(): MultiConsumer | null;
  setMulti(m: MultiConsumer | null): void;
  rebuild(opts?: { totalShards?: number; assignmentSpec?: string }): Promise<ShardSnapshot>;
  // Wave 6.44.E — drain the live consumer, invoke `between` while the
  // consumer is stopped (the caller XTRIMs streams + UNLINKs sens:* keys
  // there), then respawn under the SAME mutex used by rebuild() so a
  // concurrent POST /ingest/shards still 409s. RebuildBusyError / drain
  // RebuildTimeoutError surface to the route handler unchanged.
  haltAndFlush<T>(between: (snapshot: ShardSnapshot) => Promise<T>): Promise<T>;
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, extras: HandleExtras): boolean;
}

export function createShardRuntime(opts: ShardRuntimeOptions): ShardRuntime {
  let totalShards = Math.max(1, Math.floor(opts.initialTotalShards));
  let assignmentSpec = opts.initialAssignmentSpec;
  let assignment = parseShardAssignment(assignmentSpec, totalShards);
  let multi: MultiConsumer | null = null;
  let rebuilding = false;
  let rebuildStartedAt: string | null = null;

  const streamsFor = (a: readonly number[], total: number): string[] =>
    a.map((s) => shardStreamKey(opts.baseStream, s, total));

  const snapshot = (): ShardSnapshot => {
    const s: ShardSnapshot = {
      totalShards,
      assignment: assignment.slice(),
      streams: streamsFor(assignment, totalShards),
      rebuilding,
    };
    if (rebuilding && rebuildStartedAt) s.rebuild_started_at = rebuildStartedAt;
    return s;
  };

  // Wave 6.32.A — resolve the rebuild budget per-call: explicit option wins,
  // then env (so operators can dial it without redeploying), then 30 s default.
  const resolveRebuildTimeoutMs = (): number => {
    if (opts.rebuildTimeoutMs !== undefined && opts.rebuildTimeoutMs > 0) return opts.rebuildTimeoutMs;
    const env = Number(process.env.INGEST_REBUILD_TIMEOUT_MS);
    if (Number.isFinite(env) && env > 0) return env;
    return 30_000;
  };

  const rebuild = async (input?: { totalShards?: number; assignmentSpec?: string }): Promise<ShardSnapshot> => {
    if (rebuilding) throw new RebuildBusyError();
    const nextTotal = input?.totalShards !== undefined ? Math.floor(input.totalShards) : totalShards;
    if (!Number.isInteger(nextTotal) || nextTotal < 1) {
      throw new InvalidShardSpecError("totalShards must be a positive integer");
    }
    const nextSpec = input?.assignmentSpec ?? (input?.totalShards !== undefined ? "all" : assignmentSpec);
    const nextAssignment = parseShardAssignment(nextSpec, nextTotal);
    if (nextAssignment.length === 0) {
      throw new InvalidShardSpecError(`assignment ${nextSpec} resolves to no shards for totalShards=${nextTotal}`);
    }

    const timeoutMs = resolveRebuildTimeoutMs();
    rebuilding = true;
    rebuildStartedAt = new Date().toISOString();
    // Wave 6.43.A — track timeouts so finally can detach the orphaned multi.
    // A hung `multi.stop()` leaves the previous consumer reference live; the
    // next rebuild would call .stop() on the same dead client and hang again.
    // Mirror the /ingest/shards/reset clear pattern: null the reference so a
    // fresh consumer is spawned without operator intervention.
    let timedOut = false;
    try {
      if (multi) {
        try {
          await withTimeout(multi.stop(), timeoutMs, "drain");
        } catch (err) {
          if (err instanceof RebuildTimeoutError) throw err;
          opts.logger?.warn("drain previous consumers failed", { err: String(err) });
        }
      }
      totalShards = nextTotal;
      assignmentSpec = nextSpec;
      assignment = nextAssignment;
      multi = await withTimeout(opts.spawn(totalShards, assignment), timeoutMs, "spawn");
      return snapshot();
    } catch (err) {
      if (err instanceof RebuildTimeoutError) timedOut = true;
      throw err;
    } finally {
      rebuilding = false;
      rebuildStartedAt = null;
      if (timedOut) multi = null;
    }
  };

  // Wave 6.44.E — same in-flight mutex and timeout budget as rebuild(), but
  // with a caller-supplied step between drain and respawn so the api's
  // /admin/cancel-all-runs proxy can XTRIM + SCAN/UNLINK while no consumer
  // is reading the stream. Respawn uses the live (totalShards, assignment)
  // so the consumer comes back exactly as it was before the halt.
  const haltAndFlush = async <T>(between: (snapshot: ShardSnapshot) => Promise<T>): Promise<T> => {
    if (rebuilding) throw new RebuildBusyError();
    const timeoutMs = resolveRebuildTimeoutMs();
    rebuilding = true;
    rebuildStartedAt = new Date().toISOString();
    let timedOut = false;
    try {
      if (multi) {
        try {
          await withTimeout(multi.stop(), timeoutMs, "drain");
        } catch (err) {
          if (err instanceof RebuildTimeoutError) throw err;
          opts.logger?.warn("drain previous consumers failed", { err: String(err) });
        }
        multi = null;
      }
      const result = await between(snapshot());
      multi = await withTimeout(opts.spawn(totalShards, assignment), timeoutMs, "spawn");
      return result;
    } catch (err) {
      if (err instanceof RebuildTimeoutError) timedOut = true;
      throw err;
    } finally {
      rebuilding = false;
      rebuildStartedAt = null;
      if (timedOut) multi = null;
    }
  };

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer | string) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
      req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", rejectBody);
    });
  }

  const writeJson = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse, extras: HandleExtras): boolean => {
    if (req.url === "/ingest/shards" && req.method === "GET") {
      writeJson(res, 200, snapshot());
      return true;
    }
    if (req.url === "/ingest/shards" && req.method === "POST") {
      void (async (): Promise<void> => {
        let parsed: { totalShards?: unknown; assignment?: unknown };
        try {
          const raw = await readBody(req);
          parsed = raw.length === 0 ? {} : (JSON.parse(raw) as typeof parsed);
        } catch {
          writeJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const t = parsed.totalShards;
        if (typeof t !== "number" || !Number.isFinite(t) || !Number.isInteger(t) || t < 1) {
          writeJson(res, 400, { error: "totalShards must be a positive integer" });
          return;
        }
        const spec = typeof parsed.assignment === "string" ? parsed.assignment : "all";
        try {
          const out = await rebuild({ totalShards: t, assignmentSpec: spec });
          writeJson(res, 200, out);
        } catch (err) {
          if (err instanceof RebuildBusyError) { writeJson(res, 409, { error: err.message }); return; }
          if (err instanceof InvalidShardSpecError) { writeJson(res, 400, { error: err.message }); return; }
          // Wave 6.32.A — drain/spawn exceeded INGEST_REBUILD_TIMEOUT_MS; the
          // finally block already cleared the rebuilding flag so the next POST
          // is accepted.
          if (err instanceof RebuildTimeoutError) { writeJson(res, 504, { error: err.message, stage: err.stage, timeout_ms: err.timeoutMs }); return; }
          writeJson(res, 500, { error: String((err as Error)?.message ?? err) });
        }
      })();
      return true;
    }
    // Wave 6.32.B — operator recovery for a stuck rebuild mutex. When the
    // previous rebuild() awaits a `multi.stop()` or `opts.spawn()` that hangs
    // forever (e.g. operator flushed Redis mid-ingest), the in-memory
    // `rebuilding` flag leaks and every subsequent POST /ingest/shards 409s
    // until the service restarts. This endpoint force-clears the flag and
    // abandons the old multi reference WITHOUT awaiting stop() — that's the
    // whole point: if stop() worked we wouldn't need to be here. Destructive:
    // any in-flight messages owned by the abandoned multi may be lost.
    if (req.url === "/ingest/shards/reset" && req.method === "POST") {
      rebuilding = false;
      rebuildStartedAt = null;
      multi = null;
      writeJson(res, 200, { rebuilding: false, multi_detached: true });
      return true;
    }
    if (req.url === "/ingest/status" && req.method === "GET") {
      writeJson(res, 200, { ...snapshot(), consumed: extras.consumed, errors: extras.errors, ready: extras.ready });
      return true;
    }
    return false;
  };

  return {
    snapshot, getMulti: () => multi, setMulti: (m) => { multi = m; },
    rebuild, haltAndFlush, handleRequest,
  };
}
