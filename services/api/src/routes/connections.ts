// CRUD + test + activate routes for Redis Enterprise cluster profiles.
//
// All write payloads accept `password` etc. as plaintext (over the wire), but
// the response always uses the redacted shape: passwords and TLS CA strings
// are returned as `"***"`. On activate, the store's redacted profile is
// pushed into the active-target singleton along with the raw credentials so
// any local Redis client factory can authenticate.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ConnectionsStore, ConnectionProfile, RedactedProfile, TestResult, CreateInput } from "../store.ts";
import { DuplicateEndpointError } from "../store.ts";
import { setActiveTarget, setActiveTargetLabel } from "../active-target.ts";
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

// Wave 5.59 — true when the patch flips host/port/tls/db/clusterMode (the
// identity tuple in active-target.targetKey). Renames and credential rotations
// are NOT included here: name is not part of targetKey, and creds rotation
// already bumps credsGeneration via setActiveTarget. Used to gate edit-while-
// active behind the same inflight lockout as POST /activate.
function identityWouldChange(prev: ConnectionProfile, patch: Partial<CreateInput>): boolean {
  if (patch.host !== undefined && patch.host !== prev.host) return true;
  if (patch.port !== undefined && patch.port !== prev.port) return true;
  if (patch.db !== undefined && (patch.db ?? 0) !== (prev.db ?? 0)) return true;
  if (patch.clusterMode !== undefined && !!patch.clusterMode !== !!prev.clusterMode) return true;
  if (patch.tls !== undefined && !!patch.tls?.enabled !== !!prev.tls?.enabled) return true;
  return false;
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
    try {
      const p = await store.create(req.body);
      reply.code(201);
      return publicProfile(p);
    } catch (err) {
      if (err instanceof DuplicateEndpointError) {
        reply.code(409);
        return {
          error: "duplicate-endpoint",
          message: err.message,
          existing_id: err.existing_id,
          existing_name: err.existing_name,
          host: err.host,
          port: err.port,
          db: err.db,
        };
      }
      throw err;
    }
  });

  // Stateless reachability probe for the add-connection wizard. Accepts the
  // same body as POST /connections but does not persist a profile.
  app.post<{ Body: CreateInput }>(
    "/connections/probe",
    { config: { category: "light" } },
    async (req, reply) => {
      const body = req.body;
      if (!body?.host || typeof body.host !== "string" || !body.host.trim()) {
        reply.code(400);
        return { error: "host is required" };
      }
      const port = Number(body.port);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        reply.code(400);
        return { error: "port must be between 1 and 65535" };
      }
      const t: ConnectionTester = tester ?? defaultTester;
      return t(profileFromProbeInput(body));
    },
  );

  // Wave 6.21 — connection-store reads are in-memory (the store keeps a
  // snapshot) but tag them `light` for consistency: the small subset of
  // routes here that hit Redis (the source-of-truth load on cold start) all
  // do short GETs/HGETs, never FT.AGGREGATE/FCALL. Heavy stays reserved for
  // /calc and friends.
  app.get("/connections", { config: { category: "light" } }, async () => (await store.list()).map(publicProfile));

  app.get("/connections/active", { config: { category: "light" } }, async (_req, reply) => {
    const p = store.getActive();
    if (!p) { reply.code(404); return { error: "no active connection" }; }
    return publicProfile(p);
  });

  app.get<{ Params: { id: string } }>(
    "/connections/:id",
    { config: { category: "light" } },
    async (req, reply) => {
      const p = await store.get(req.params.id);
      if (!p) { reply.code(404); return { error: "not found" }; }
      return publicProfile(p);
    },
  );

  // Wave 5.59 — edit-while-active: when the edited id matches the active
  // profile, push the updated values into the active-target singleton so the
  // ActiveTargetPill and sidecar watchers pick them up without requiring a
  // manual re-activate. Identity-changing edits (host/port/tls/db/clusterMode)
  // would rebuild the cached ioredis client, so we block them when inflight
  // ops exist — same 409 payload shape as POST /connections/:id/activate.
  type UpdateRoute = { Params: { id: string }; Body: Partial<CreateInput> };
  const updateHandler = async (
    req: FastifyRequest<UpdateRoute>,
    reply: FastifyReply,
  ) => {
    const prevActiveRaw = store.getActiveRaw();
    const isActive = !!prevActiveRaw && prevActiveRaw.id === req.params.id;
    if (isActive && identityWouldChange(prevActiveRaw!, req.body)) {
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
    }
    let p: RedactedProfile | null;
    try {
      p = await store.update(req.params.id, req.body);
    } catch (err) {
      if (err instanceof DuplicateEndpointError) {
        reply.code(409);
        return {
          error: "duplicate-endpoint",
          message: err.message,
          existing_id: err.existing_id,
          existing_name: err.existing_name,
          host: err.host,
          port: err.port,
          db: err.db,
        };
      }
      throw err;
    }
    if (!p) { reply.code(404); return { error: "not found" }; }
    if (isActive) {
      const raw = store.getActiveRaw();
      if (raw) {
        // Wave 5.62 — branch on what actually changed to avoid spuriously
        // re-running bootstrap. Identity edits (host/port/tls/db/clusterMode)
        // legitimately point at a different Redis, so we run the full
        // activateProfileTarget flow (bumps credsGeneration, fires listeners,
        // bootstrap re-runs against the new target). A pure rename is just a
        // presentation tweak — refresh the label silently so the pill picks
        // it up on its next poll without the "Bootstrapping…" banner.
        // Creds rotations (username/password) also funnel through
        // activateProfileTarget: the simpler path. Creds rotation is rare,
        // and a bootstrap re-run on a creds change is acceptable; this
        // avoids adding a separate credsGeneration-only helper just for an
        // edge case.
        // Wave 5.65 — compare credentials by VALUE, not by presence. The UI's
        // updateConnection() submits the full form body on every save (it
        // only conditionally omits `password`), so `username` is always
        // present and the old `!== undefined` check fired on every edit-of-
        // active, re-running bootstrap on pure renames. An empty password
        // string is treated as "keep existing" (defence in depth — the UI
        // already strips it before sending). Behaviour change: callers that
        // echo unchanged username/password no longer trigger bootstrap.
        const usernameChanged =
          req.body.username !== undefined &&
          (req.body.username ?? "") !== (prevActiveRaw!.username ?? "");
        const passwordChanged =
          req.body.password !== undefined &&
          req.body.password.length > 0 &&
          req.body.password !== prevActiveRaw!.password;
        const credsChanged = usernameChanged || passwordChanged;
        if (identityWouldChange(prevActiveRaw!, req.body) || credsChanged) {
          activateProfileTarget(raw);
        } else {
          setActiveTargetLabel(raw.name);
        }
      }
    }
    return publicProfile(p);
  };

  app.put<UpdateRoute>("/connections/:id", updateHandler);
  app.patch<UpdateRoute>("/connections/:id", updateHandler);

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

function profileFromProbeInput(input: CreateInput): ConnectionProfile {
  const now = new Date().toISOString();
  return {
    id: "probe-ephemeral",
    name: input.name?.trim() || "probe",
    host: input.host.trim(),
    port: Number(input.port),
    username: input.username,
    password: input.password,
    tls: input.tls,
    db: input.db,
    clusterMode: input.clusterMode,
    created_at: now,
    updated_at: now,
  };
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

// Wave 5.58 — display label vs MODULE LIST internal name. RedisBloom reports
// itself as "bf" (covers Bloom/Cuckoo/Count-Min/Top-K/T-Digest), TimeSeries as
// "timeseries". Response shape stays `{ name, present }` — `name` is the
// human label so the UI doesn't need a contract change.
const REQUIRED_MODULES = [
  { displayName: "JSON",          moduleListName: "ReJSON" },
  { displayName: "Search",        moduleListName: "search" },
  { displayName: "Time Series",   moduleListName: "timeseries" },
  { displayName: "Probabilistic", moduleListName: "bf" },
] as const;

function parseModuleList(raw: unknown[]): Array<{ name: string; present: boolean }> {
  const found = new Set<string>();
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      const idx = entry.indexOf("name");
      if (idx >= 0 && typeof entry[idx + 1] === "string") found.add(entry[idx + 1] as string);
    }
  }
  return REQUIRED_MODULES.map((m) => ({ name: m.displayName, present: found.has(m.moduleListName) }));
}
