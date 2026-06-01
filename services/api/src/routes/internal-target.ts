// Internal full-credential active-target endpoint.
//
// Used by the source service (Wave 5.16u) — and later loadgen (5.16v) — to
// follow the api's active Redis target without re-encoding the connection
// store. Returns host/port/tls/db/label plus the plaintext password from the
// encrypted Connections store and a monotonically-increasing `version` that
// bumps on every setActiveTarget call so pollers can detect identity changes
// without diffing all fields. Auth is a static bearer token read from
// $INTERNAL_API_TOKEN at boot. NEVER log the token or the password.

import type { FastifyInstance } from "fastify";
import { getActiveTarget, onActiveTargetChange } from "../active-target.ts";
import type { ConnectionsStore } from "../store.ts";

let version = 1;

// Listener is registered once at module load so version bumps regardless of
// how many Fastify instances are created in tests. `onActiveTargetChange`
// itself is keyed on a Set so duplicate registrations would still be safe.
onActiveTargetChange(() => {
  version += 1;
});

export function resetInternalTargetVersionForTests(): void {
  version = 1;
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
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${token}`) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const t = getActiveTarget();
    const out: Record<string, unknown> = {
      host: t.host,
      port: t.port,
      tls: !!t.tls,
      db: t.db ?? 0,
      label: t.label,
      version,
    };
    if (store) {
      const raw = store.getActiveRaw();
      if (raw?.password) out.password = raw.password;
    }
    return out;
  });
}
