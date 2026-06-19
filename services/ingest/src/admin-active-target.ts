// Wave 6.43.B.2 — HTTP endpoints the api switch coordinator pushes to during
// a target swap. The api owns the protocol (PUBLISH on the old client +
// /switch-ack collection); this file exposes a parallel push path so the
// coordinator does not depend on Redis pub/sub being reachable. Routes:
//
//   POST /admin/active-target/prepare  body {switch_id, target}
//     → drain in-flight consumer + pause; respond {ok, switch_id, phase:"drained"}
//   POST /admin/active-target/commit   body {switch_id, target}
//     → refresh the active-target client + resume; respond {ok, switch_id, phase:"committed"}
//
// Bearer-guarded by INTERNAL_API_TOKEN (same posture as /ingest/halt-and-flush
// and /ingest/shards). The drain mechanism is the same one used by 6.43.A
// self-heal — multi.stop() + setMulti(null) — so no new shard-runtime
// primitives are introduced. Resume reuses the existing active-target
// watcher polling / refresh path so this file holds no Redis client state.
//
// Wave 6.44.D1 — commit-phase reconnect retries on RebuildBusyError. When 5
// switches fire in <5s the previous switch's rebuild is still in flight when
// the new commit arrives; the rebuild mutex throws RebuildBusyError and the
// commit-phase ACK was previously lost (per-service state stuck at "drained").
// We now retry the commit closure up to 3 times with 250→500→1000ms backoff
// before responding {phase:"push_failed"} with the busy error in the body.
// Retry loop probes pendingSwitchId between attempts so a newer prepare
// mid-retry causes a clean 409 (superseded) instead of stomping the new
// switch's state.
//
// IMPORTANT: this is push-only; the existing watcher polling at
// /internal/redis/active-target/full stays in place as the safety net.

import type http from "node:http";

export interface AdminActiveTargetDeps {
  // INTERNAL_API_TOKEN. If undefined the routes still register but skip auth
  // — matches the boot mode where the token is unset for local dev. Tests
  // pass a fixed string and exercise both the matching and mismatching cases.
  internalToken: string | undefined;
  // Stop the live consumer multi and leave it paused (setMulti(null)). The
  // existing 6.43.A self-heal path does this exact pair; we inject the
  // combined op so tests can stub it without spinning a shard-runtime.
  drain: () => Promise<void>;
  // Force a refresh of the active-target client (watcher.pollOnce or, in
  // single-target mode, shardRuntime.rebuild) and resume consumption against
  // whatever target the api now reports as active.
  commit: () => Promise<void>;
  // Hard cap on the drain step inside prepare. Defaults to 30s; tests pass a
  // small value (e.g. 30ms) and stub `drain` with a hung promise to exercise
  // the 504 path.
  drainTimeoutMs?: number;
  logger?: {
    warn: (meta: Record<string, unknown>, msg: string) => void;
    error: (meta: Record<string, unknown>, msg: string) => void;
  };
}

export class PrepareDrainTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`prepare drain timed out after ${timeoutMs}ms`);
    this.name = "PrepareDrainTimeoutError";
  }
}

interface ParsedBody {
  switch_id: string;
  target: { label: string; [k: string]: unknown };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer | string) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseBody(raw: string): ParsedBody | { error: string } {
  let parsed: unknown;
  try { parsed = raw.length === 0 ? {} : JSON.parse(raw); } catch { return { error: "invalid JSON body" }; }
  const obj = parsed as { switch_id?: unknown; target?: unknown };
  if (typeof obj.switch_id !== "string" || obj.switch_id.length === 0) {
    return { error: "switch_id must be a non-empty string" };
  }
  const t = obj.target as { label?: unknown } | undefined;
  if (!t || typeof t.label !== "string" || t.label.length === 0) {
    return { error: "target.label must be a non-empty string" };
  }
  return { switch_id: obj.switch_id, target: t as ParsedBody["target"] };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PrepareDrainTimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Wave 6.44.D1 — commit-phase reconnect retry schedule. Three attempts after
// the initial call (250ms → 500ms → 1s) covers the typical rebuild window
// observed during S6 rapid-switch (~1.2s end-to-end) without dragging the
// HTTP push past the api's SWITCH_PUSH_TIMEOUT_MS (2.5s default + the api
// already waits past commit). Exported for tests to assert exact timings.
export const COMMIT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRebuildBusyError(err: unknown): boolean {
  return err instanceof Error && err.name === "RebuildBusyError";
}

export function makeAdminActiveTargetHandler(
  deps: AdminActiveTargetDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  // In-flight switch_id from the most recent successful prepare. Commit
  // requires a match — protects against a stale commit ACK landing after the
  // coordinator has moved on to a newer switch. Cleared on commit success.
  let pendingSwitchId: string | null = null;
  const drainTimeoutMs = deps.drainTimeoutMs ?? 30_000;
  const log = deps.logger;

  const writeJson = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const checkAuth = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (!deps.internalToken) return true;
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${deps.internalToken}`) {
      writeJson(res, 401, { ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  };

  return async (req, res) => {
    const url = req.url ?? "";
    const isPrepare = url === "/admin/active-target/prepare" && req.method === "POST";
    const isCommit = url === "/admin/active-target/commit" && req.method === "POST";
    if (!isPrepare && !isCommit) return false;

    if (!checkAuth(req, res)) return true;

    let raw: string;
    try { raw = await readBody(req); } catch { writeJson(res, 400, { ok: false, error: "body read failed" }); return true; }
    const parsed = parseBody(raw);
    if ("error" in parsed) { writeJson(res, 400, { ok: false, error: parsed.error }); return true; }

    if (isPrepare) {
      try {
        await withTimeout(deps.drain(), drainTimeoutMs);
        pendingSwitchId = parsed.switch_id;
        writeJson(res, 200, { ok: true, switch_id: parsed.switch_id, phase: "drained" });
      } catch (err) {
        if (err instanceof PrepareDrainTimeoutError) {
          log?.warn({ switch_id: parsed.switch_id, timeout_ms: err.timeoutMs }, "active-target prepare drain timed out");
          writeJson(res, 504, { ok: false, error: err.message, timeout_ms: err.timeoutMs });
        } else {
          log?.error({ err: String(err), switch_id: parsed.switch_id }, "active-target prepare failed");
          writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return true;
    }

    // commit
    if (pendingSwitchId !== null && pendingSwitchId !== parsed.switch_id) {
      writeJson(res, 409, { ok: false, error: "switch_id mismatch", pending_switch_id: pendingSwitchId });
      return true;
    }
    // Wave 6.44.D1 — retry loop around the commit closure on RebuildBusyError.
    // Non-busy errors short-circuit to the existing 500 path so we don't add
    // ~1.75s of latency to a permanent failure. Between attempts we re-check
    // pendingSwitchId: if a newer prepare landed (overwriting it) we abandon
    // this switch and respond 409 so the api stops waiting on this ACK.
    let lastErr: unknown = null;
    let committed = false;
    let superseded = false;
    for (let attempt = 0; attempt <= COMMIT_RETRY_DELAYS_MS.length; attempt++) {
      if (pendingSwitchId !== null && pendingSwitchId !== parsed.switch_id) {
        superseded = true;
        break;
      }
      try {
        await deps.commit();
        committed = true;
        break;
      } catch (err) {
        lastErr = err;
        if (!isRebuildBusyError(err)) break;
        if (attempt === COMMIT_RETRY_DELAYS_MS.length) break;
        const delay = COMMIT_RETRY_DELAYS_MS[attempt];
        log?.warn(
          { switch_id: parsed.switch_id, attempt: attempt + 1, delay_ms: delay, err: String(err) },
          "active-target commit reconnect busy, retrying",
        );
        await sleep(delay);
      }
    }
    if (committed) {
      pendingSwitchId = null;
      writeJson(res, 200, { ok: true, switch_id: parsed.switch_id, phase: "committed" });
    } else if (superseded) {
      writeJson(res, 409, {
        ok: false,
        error: "switch_id superseded by newer prepare",
        switch_id: parsed.switch_id,
        pending_switch_id: pendingSwitchId,
      });
    } else {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      if (isRebuildBusyError(lastErr)) {
        // Wave 6.44.D1 — retries exhausted. Explicit phase:"push_failed" so
        // the api / log surface can show a clear failure state rather than a
        // stale "drained". The polling fallback still converges within 30s.
        log?.error(
          { switch_id: parsed.switch_id, err: msg, attempts: COMMIT_RETRY_DELAYS_MS.length + 1 },
          "active-target commit reconnect exhausted retries on RebuildBusyError",
        );
        writeJson(res, 500, {
          ok: false,
          switch_id: parsed.switch_id,
          phase: "push_failed",
          error: msg,
        });
      } else {
        log?.error({ err: msg, switch_id: parsed.switch_id }, "active-target commit failed");
        writeJson(res, 500, { ok: false, error: msg });
      }
    }
    return true;
  };
}
