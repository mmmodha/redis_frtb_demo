// Internal full-credential active-target endpoint.
//
// Used by the source service (Wave 5.16u) — and later loadgen (5.16v) — to
// follow the api's active Redis target without re-encoding the connection
// store. Returns host/port/tls/db/label plus the plaintext password from the
// encrypted Connections store and a monotonically-increasing `version` that
// bumps on every setActiveTarget commit so pollers can detect identity
// changes without diffing all fields. Auth is a static bearer token read
// from $INTERNAL_API_TOKEN at boot. NEVER log the token or the password.
//
// Wave 6.43.B.1 — co-located with the switch coordinator endpoints below:
//   * POST /internal/redis/active-target/ack — service ACK from prepare /
//     commit phases. Updates the in-memory switchState in active-target.ts.
//   * GET  /internal/redis/active-target/switch-status — current switch_id,
//     phase, and per-service progress (drained/committed/drain_timeout).
//   Subscribers ship in 6.43.B.2/3; this is just the api-side wiring.

import type { FastifyInstance } from "fastify";
import {
  getActiveTarget,
  getActiveTargetVersion,
  getSwitchStatus,
  recordSwitchAck,
  __resetActiveTargetVersionForTests,
} from "../active-target.ts";
import type { ConnectionsStore } from "../store.ts";

export function resetInternalTargetVersionForTests(): void {
  __resetActiveTargetVersionForTests();
}

function bearerOk(req: { headers: Record<string, unknown> }, token: string): boolean {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth === `Bearer ${token}`;
}

export function registerInternalTargetRoutes(
  app: FastifyInstance,
  store?: ConnectionsStore,
): void {
  const token = process.env.INTERNAL_API_TOKEN;

  app.get("/internal/redis/active-target/full", async (req, reply) => {
    if (!token) {
      reply.code(503);
      return { error: "INTERNAL_API_TOKEN not configured" };
    }
    if (!bearerOk(req as { headers: Record<string, unknown> }, token)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const t = getActiveTarget();
    // Wave 5.99B — surface clusterMode so the source watcher can branch between
    // ioredis Cluster (true OSS Redis Cluster) and the single-node client
    // (proxy-endpoint / Enterprise-style). Always emitted as a boolean; legacy
    // ActiveTarget payloads with no clusterMode default to false.
    const out: Record<string, unknown> = {
      host: t.host,
      port: t.port,
      tls: !!t.tls,
      db: t.db ?? 0,
      label: t.label,
      clusterMode: t.clusterMode === true,
      version: getActiveTargetVersion(),
    };
    if (store) {
      const raw = store.getActiveRaw();
      if (raw?.password) out.password = raw.password;
    }
    return out;
  });

  // Wave 6.43.B.1 — subscriber ACK ingress. The ingest / source / loadgen
  // services POST here after they've drained their in-flight work (phase
  // "drained") or after they've rebound their Redis client to the new
  // target (phase "committed"). Stale switch_ids are rejected with 409 so
  // a late ACK from a superseded switch can't poison the next switch's
  // status. Malformed bodies surface as 400 with a structured `reason`.
  app.post("/internal/redis/active-target/ack", async (req, reply) => {
    if (!token) {
      reply.code(503);
      return { error: "INTERNAL_API_TOKEN not configured" };
    }
    if (!bearerOk(req as { headers: Record<string, unknown> }, token)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const result = recordSwitchAck(req.body);
    if (result.status === "ok") {
      reply.code(200);
      return { ok: true };
    }
    if (result.status === "superseded") {
      reply.code(409);
      return { error: "superseded" };
    }
    reply.code(400);
    return { error: "malformed", reason: result.reason };
  });

  // Wave 6.43.B.1 — switch progress surface. Used by the UI banner (6.43.B.4)
  // and by ops to see which service ACKed what and which are pending. Never
  // returns secrets — only switch_id, phase, and per-service progress.
  app.get("/internal/redis/active-target/switch-status", async (req, reply) => {
    if (!token) {
      reply.code(503);
      return { error: "INTERNAL_API_TOKEN not configured" };
    }
    if (!bearerOk(req as { headers: Record<string, unknown> }, token)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    return getSwitchStatus();
  });
}
