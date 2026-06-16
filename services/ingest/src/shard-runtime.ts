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
}

export interface ShardSnapshot {
  totalShards: number;
  assignment: number[];
  streams: string[];
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

export interface ShardRuntime {
  snapshot(): ShardSnapshot;
  getMulti(): MultiConsumer | null;
  setMulti(m: MultiConsumer | null): void;
  rebuild(opts?: { totalShards?: number; assignmentSpec?: string }): Promise<ShardSnapshot>;
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, extras: HandleExtras): boolean;
}

export function createShardRuntime(opts: ShardRuntimeOptions): ShardRuntime {
  let totalShards = Math.max(1, Math.floor(opts.initialTotalShards));
  let assignmentSpec = opts.initialAssignmentSpec;
  let assignment = parseShardAssignment(assignmentSpec, totalShards);
  let multi: MultiConsumer | null = null;
  let rebuilding = false;

  const streamsFor = (a: readonly number[], total: number): string[] =>
    a.map((s) => shardStreamKey(opts.baseStream, s, total));

  const snapshot = (): ShardSnapshot => ({
    totalShards,
    assignment: assignment.slice(),
    streams: streamsFor(assignment, totalShards),
  });

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

    rebuilding = true;
    try {
      if (multi) {
        try { await multi.stop(); } catch (err) {
          opts.logger?.warn("drain previous consumers failed", { err: String(err) });
        }
      }
      totalShards = nextTotal;
      assignmentSpec = nextSpec;
      assignment = nextAssignment;
      multi = await opts.spawn(totalShards, assignment);
      return snapshot();
    } finally {
      rebuilding = false;
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
          writeJson(res, 500, { error: String((err as Error)?.message ?? err) });
        }
      })();
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
    rebuild, handleRequest,
  };
}
