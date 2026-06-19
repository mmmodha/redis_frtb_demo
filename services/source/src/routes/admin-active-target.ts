// Wave 6.43.B.3 — POST /admin/active-target/prepare + /commit
//
// Coordinator-driven Redis target swap endpoints. Bearer-token guarded by
// INTERNAL_API_TOKEN (same posture as ingest's /ingest/halt-and-flush).
// On prepare: drain caller-supplied in-flight work and respond `phase=drained`.
// On commit: caller-supplied callback (typically the active-target watcher's
// pollOnce) reconnects to the new target and we respond `phase=committed`.
// Both endpoints echo the incoming switch_id back for coordinator correlation.

import type { FastifyInstance } from "fastify";

export interface SwitchAdminOpts {
  internalToken?: string;
  // Prepare callback: stop in-flight work bound to the previous target. Source
  // has no continuous worker loop so the default no-op is fine; the endpoint
  // still acks with `phase=drained` so the coordinator can proceed.
  prepareSwitch?: () => Promise<void>;
  // Commit callback: reconnect to the new target. Typically the watcher's
  // pollOnce(). Failures surface as 500.
  commitSwitch?: () => Promise<void>;
  // Drain budget for prepareSwitch. Default 30s mirrors ingest's rebuild
  // timeout default.
  prepareTimeoutMs?: number;
}

interface SwitchBody {
  switch_id?: string;
  target?: unknown;
}

const DEFAULT_PREPARE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function registerSwitchAdminRoutes(app: FastifyInstance, opts: SwitchAdminOpts): void {
  const token = opts.internalToken;
  const prepareTimeoutMs = opts.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;

  // Token-less mode keeps unit tests ergonomic; in production index.ts wires
  // INTERNAL_API_TOKEN so 401 is enforced. Mirrors the ingest halt-and-flush
  // handler which also no-ops the bearer check when the env var is unset.
  const checkAuth = (auth: string | undefined): boolean => {
    if (!token) return true;
    return auth === `Bearer ${token}`;
  };

  app.post<{ Body: SwitchBody }>("/admin/active-target/prepare", async (req, reply) => {
    if (!checkAuth(req.headers.authorization)) {
      reply.code(401);
      return { ok: false, error: "unauthorized" };
    }
    const body = req.body ?? {};
    const switch_id = typeof body.switch_id === "string" ? body.switch_id : undefined;
    try {
      if (opts.prepareSwitch) {
        await withTimeout(opts.prepareSwitch(), prepareTimeoutMs, "prepare");
      }
      return { ok: true, switch_id, phase: "drained" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out/.test(msg)) {
        reply.code(504);
        return { ok: false, error: msg, switch_id };
      }
      reply.code(500);
      return { ok: false, error: msg, switch_id };
    }
  });

  app.post<{ Body: SwitchBody }>("/admin/active-target/commit", async (req, reply) => {
    if (!checkAuth(req.headers.authorization)) {
      reply.code(401);
      return { ok: false, error: "unauthorized" };
    }
    const body = req.body ?? {};
    const switch_id = typeof body.switch_id === "string" ? body.switch_id : undefined;
    try {
      if (opts.commitSwitch) await opts.commitSwitch();
      return { ok: true, switch_id, phase: "committed" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { ok: false, error: msg, switch_id };
    }
  });
}
