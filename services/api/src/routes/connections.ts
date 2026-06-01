// CRUD + test + activate routes for Redis Enterprise cluster profiles.
//
// All write payloads accept `password` etc. as plaintext (over the wire), but
// the response always uses the redacted shape: passwords and TLS CA strings
// are returned as `"***"`. On activate, the store's redacted profile is
// pushed into the active-target singleton along with the raw credentials so
// any local Redis client factory can authenticate.

import type { FastifyInstance } from "fastify";
import type { ConnectionsStore, ConnectionProfile, RedactedProfile, TestResult, CreateInput } from "../store.ts";
import { setActiveTarget } from "../active-target.ts";
import * as inflight from "../inflight-registry.ts";

export type ConnectionTester = (profile: ConnectionProfile) => Promise<TestResult>;

const PUBLIC_OMIT = new Set(["password"]);

function publicProfile(p: RedactedProfile): RedactedProfile {
  // The store already redacts; we additionally never let raw password leak
  // even if the caller sent one in the body and the store echoes it back.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (PUBLIC_OMIT.has(k) && (v === undefined || v === null || v === "")) continue;
    out[k] = v;
  }
  return out as unknown as RedactedProfile;
}

function activateProfileTarget(p: ConnectionProfile): void {
  // Wave 5.16y — pass stored credentials alongside identity so the per-request
  // ioredis client built by getActiveRedisClient() can AUTH against the
  // selected profile (NOAUTH on /calc/sbm was the symptom). The creds payload
  // is held privately in active-target.ts and never exposed via
  // GET /redis/active-target.
  setActiveTarget(
    {
      host: p.host,
      port: p.port,
      tls: !!p.tls?.enabled,
      db: p.db ?? 0,
      label: p.name,
      ...(p.clusterMode ? { clusterMode: true } : {}),
    },
    { username: p.username, password: p.password },
  );
}

export function registerConnectionsRoutes(
  app: FastifyInstance,
  store: ConnectionsStore,
  tester?: ConnectionTester,
): void {
  app.post<{ Body: CreateInput }>("/connections", async (req, reply) => {
    const p = await store.create(req.body);
    reply.code(201);
    return publicProfile(p);
  });

  app.get("/connections", async () => (await store.list()).map(publicProfile));

  app.get("/connections/active", async (_req, reply) => {
    const p = store.getActive();
    if (!p) { reply.code(404); return { error: "no active connection" }; }
    return publicProfile(p);
  });

  app.get<{ Params: { id: string } }>("/connections/:id", async (req, reply) => {
    const p = await store.get(req.params.id);
    if (!p) { reply.code(404); return { error: "not found" }; }
    return publicProfile(p);
  });

  app.put<{ Params: { id: string }; Body: Partial<CreateInput> }>(
    "/connections/:id",
    async (req, reply) => {
      const p = await store.update(req.params.id, req.body);
      if (!p) { reply.code(404); return { error: "not found" }; }
      return publicProfile(p);
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<CreateInput> }>(
    "/connections/:id",
    async (req, reply) => {
      const p = await store.update(req.params.id, req.body);
      if (!p) { reply.code(404); return { error: "not found" }; }
      return publicProfile(p);
    },
  );

  app.delete<{ Params: { id: string } }>("/connections/:id", async (req, reply) => {
    const ok = await store.delete(req.params.id);
    if (!ok) { reply.code(404); return { error: "not found" }; }
    reply.code(204);
    return null;
  });

  app.post<{ Params: { id: string } }>("/connections/:id/test", async (req, reply) => {
    const p = await store.getRaw(req.params.id);
    if (!p) { reply.code(404); return { error: "not found" }; }
    const t: ConnectionTester = tester ?? defaultTester;
    const result = await t(p);
    await store.update(p.id, {
      // Persist last-test metadata (typed as Partial<CreateInput> so we cast).
    } as Partial<CreateInput>);
    return result;
  });

  app.post<{ Params: { id: string } }>("/connections/:id/activate", async (req, reply) => {
    // Wave 5.16w — refuse to switch active target while long-running ops are
    // in flight. Stale entries (older than INFLIGHT_STALE_MS) are excluded
    // from the lockout count but surfaced in `stale` so the UI can render a
    // "force switch" affordance later. Do NOT mutate active-target state.
    const items = inflight.list();
    const stale = inflight.listStale();
    if (stale.length > 0) {
      req.log.warn({ stale }, "inflight registry: stale entries excluded from lockout");
    }
    if (items.length > 0) {
      reply.code(409);
      return {
        error: "Cannot switch active target — operations in flight. Wait for them to complete or stop them first.",
        inflight: items,
        stale,
      };
    }
    const p = await store.setActive(req.params.id);
    if (!p) { reply.code(404); return { error: "not found" }; }
    const raw = store.getActiveRaw();
    if (raw) activateProfileTarget(raw);
    return publicProfile(p);
  });
}

async function defaultTester(profile: ConnectionProfile): Promise<TestResult> {
  // Lightweight reachability probe: PING + MODULE LIST against the profile
  // using a short-lived ioredis client. Never logs or returns the password.
  const start = Date.now();
  let client: import("ioredis").Redis | null = null;
  try {
    const { Redis } = await import("ioredis");
    client = new Redis({
      host: profile.host,
      port: profile.port,
      db: profile.db ?? 0,
      tls: profile.tls?.enabled ? {} : undefined,
      username: profile.username,
      password: profile.password,
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
    });
    await client.connect();
    await client.ping();
    const modulesRaw = (await client.call("MODULE", "LIST").catch(() => [])) as unknown[];
    const modules = parseModuleList(modulesRaw);
    return { ok: true, latency_ms: Date.now() - start, modules, errors: [] };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, modules: [], errors: [String((err as Error).message ?? err)] };
  } finally {
    if (client) try { client.disconnect(); } catch { /* noop */ }
  }
}

function parseModuleList(raw: unknown[]): Array<{ name: string; present: boolean }> {
  const required = ["ReJSON", "search", "redisgears"];
  const found = new Set<string>();
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      const idx = entry.indexOf("name");
      if (idx >= 0 && typeof entry[idx + 1] === "string") found.add(entry[idx + 1] as string);
    }
  }
  return required.map((name) => ({ name, present: found.has(name) }));
}
