// Active Redis target singleton.
//
// Other services (ingest, generator, source, calc, loadgen) and our own
// endpoints obtain the current target via `GET /redis/active-target`. The
// Connections store agent (task c496f7e8) will set the active target on
// profile-switch via `setActiveTarget(...)`. With no override, we fall back
// to the REDIS_URL env var, then to localhost — keeping CI / unit tests
// trivially configurable.

import { Redis } from "ioredis";

export interface ActiveTarget {
  host: string;
  port: number;
  tls: boolean;
  db: number;
  label: string;
  // Locked Wave-2 contract addition (router agent): true when target is a
  // multi-shard Redis Enterprise cluster requiring cluster-mode ioredis.
  clusterMode?: boolean;
}

export type ActiveTargetListener = (t: ActiveTarget) => void;

// Wave 5.16y — private credentials accompanying the active target. Kept
// strictly separate from the public ActiveTarget type so `getActiveTarget()`
// (and therefore `GET /redis/active-target`) cannot leak secrets. Only
// `getActiveRedisClient()` reads these to authenticate the ioredis client.
export interface ActiveTargetCreds {
  username?: string;
  password?: string;
}

let override: ActiveTarget | undefined;
let overrideCreds: ActiveTargetCreds = {};
// Monotonic per-set counter folded into the cache key so any setActiveTarget
// call invalidates the cached client — even a credentials-only rotation that
// keeps host/port/db unchanged. Avoids embedding the password itself in the
// cache key string.
let credsGeneration = 0;
const listeners = new Set<ActiveTargetListener>();
// Wave 6.21 — THREE kinds of client live behind this module, all identical
// host/port/auth/keepalive but with different per-command timeouts AND
// different multiplicity:
//   * `cachedBootClient` — commandTimeout: 10_000 (Wave 6.18c). SINGLETON.
//     Used by the api boot path (`bootstrapFrtb` + post-listen
//     `scheduleBootstrap`) so a wedged Redis Enterprise proxy fails fast and
//     `app.listen(...)` is reached. Companion to `withBootTimeout(...)` in
//     index.ts (12s). Intentionally NOT pooled: the boot path is a single,
//     infrequent call; a singleton avoids opening N sockets just to bootstrap.
//   * `heavyPool` — commandTimeout: 35_000 (Wave 6.18f). POOL of
//     `RUNTIME_REDIS_POOL_SIZE_HEAVY` (default 4) ioredis clients selected
//     round-robin. Used for slow per-request work (FT.AGGREGATE, FCALL, calc,
//     facets, sbm-total). The pool exists purely to bound blast radius: a
//     single hung command stalls only the one member it landed on; the other
//     three keep serving traffic. ioredis already pipelines commands on each
//     socket, so this is NOT a checkout/lease pool.
//   * `lightPool` — commandTimeout: 35_000 (Wave 6.18f). POOL of
//     `RUNTIME_REDIS_POOL_SIZE_LIGHT` (default 4) ioredis clients selected
//     round-robin. Used for cheap reads (observability, /admin/preflight,
//     healthz-adjacent endpoints) so a poisoned heavy connection from a slow
//     FT.AGGREGATE cannot push the snapshot/health UI to multi-second
//     latencies. Independent from heavyPool — staling a heavy member never
//     affects light, and vice versa.
// All three share the same `targetKey(...)` cache invalidation so
// `setActiveTarget` rebuilds the boot singleton AND every pool member in
// lockstep (lazily — each slot rebuilds on its next acquisition with the new
// key). Per-member recycle (see `wrapWithRecycle`) marks individual pool
// members stale on command timeouts / ETIMEDOUT / ECONNRESET / EPIPE so a
// poisoned socket self-heals without taking down its peers.
let cachedBootClient: Redis | null = null;
let cachedBootClientKey = "";

const BOOT_COMMAND_TIMEOUT_MS = 10_000;
const RUNTIME_COMMAND_TIMEOUT_DEFAULT_MS = 35_000;
const RUNTIME_POOL_SIZE_DEFAULT = 4;

// Public category label for the runtime pools. `"heavy"` is the safe default —
// any route that hasn't explicitly opted in stays on the heavy pool so a
// missing migration cannot accidentally downgrade timeout protection.
export type RuntimeCategory = "heavy" | "light";

interface PoolMember {
  // Underlying ioredis client. `null` when the slot is unbuilt OR has been
  // marked stale by an error event / wrapper rejection hook; rebuilt lazily
  // on the next round-robin acquisition.
  client: Redis | null;
  // Recycle-aware Proxy returned to callers. Cached alongside `client` so a
  // re-acquisition of the same slot under the same `targetKey(...)` returns
  // the same reference (preserves `===` identity for tests / consumers that
  // hold a per-request handle).
  wrapper: Redis | null;
  // The `targetKey(...)` this slot was built against. Mismatch with the
  // current `targetKey(...)` is the lockstep invalidation hook — `setActive
  // Target` rebuilds via key bump, not by walking the pool.
  key: string;
}

interface Pool {
  members: PoolMember[];
  rrIndex: number;
}

const heavyPool: Pool = { members: [], rrIndex: 0 };
const lightPool: Pool = { members: [], rrIndex: 0 };

// Test seam: replaces the per-member `Redis` factory so unit tests can drive
// pool behaviour (round-robin distribution, recycle on simulated timeout,
// independent pools) without opening real sockets. Production keeps this null
// and `buildClient(...)` is used.
let runtimeClientFactoryForTests:
  | ((t: ActiveTarget, c: ActiveTargetCreds, commandTimeout: number) => Redis)
  | null = null;

// Read on each runtime-client build so tests can flip the env without
// reloading the module. Falsy / non-numeric values fall back to the default.
function getRuntimeCommandTimeoutMs(): number {
  const raw = process.env.RUNTIME_REDIS_COMMAND_TIMEOUT_MS;
  if (raw === undefined || raw === "") return RUNTIME_COMMAND_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : RUNTIME_COMMAND_TIMEOUT_DEFAULT_MS;
}

// Wave 6.21 — pool sizes read per-acquisition so tests / ops can re-tune
// without restarting. Non-positive / non-numeric values fall back to the
// default (4); a stray `RUNTIME_REDIS_POOL_SIZE_HEAVY=0` MUST NOT collapse the
// pool to zero members.
function getPoolSize(envName: string): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return RUNTIME_POOL_SIZE_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : RUNTIME_POOL_SIZE_DEFAULT;
}

function targetKey(t: ActiveTarget): string {
  return `${t.host}|${t.port}|${t.tls ? 1 : 0}|${t.db}|${t.clusterMode ? 1 : 0}|${credsGeneration}`;
}

// Three kinds of mutation are supported on this singleton:
//   1. Full identity switch — `setActiveTarget(...)`: replaces host/port/tls/db
//      (and creds), bumps `credsGeneration` so the cached ioredis client is
//      rebuilt, and fires listeners (the bootstrap scheduler hangs off this).
//   2. Label-only refresh — `setActiveTargetLabel(...)`: a rename of the
//      currently-active profile. The Redis we're pointed at is unchanged, so we
//      MUST NOT bump `credsGeneration` (would invalidate the cached client for
//      no reason) and MUST NOT fire listeners (would re-trigger bootstrap).
//      Consumers learn the new label via the next `GET /redis/active-target`.
//   3. Creds-only rotation — currently handled by funnelling through
//      `setActiveTarget`. It bumps creds and re-runs bootstrap; acceptable
//      because creds rotations are rare. Documented here so a future split
//      (setActiveTargetCreds) can be added without surprising existing callers.
export function setActiveTarget(t: ActiveTarget, creds?: ActiveTargetCreds): void {
  // Strip any stray fields (notably `password`) — the public type is intentionally
  // password-free; secrets live only in the encrypted Connections store and in
  // the private `overrideCreds` slot below.
  override = {
    host: t.host,
    port: t.port,
    tls: !!t.tls,
    db: t.db ?? 0,
    label: t.label,
    ...(t.clusterMode ? { clusterMode: true } : {}),
  };
  // Wave 5.16y — store creds privately so getActiveRedisClient() can
  // authenticate. Callers that don't pass creds (legacy tests, env-only flow)
  // get an empty record and the client is built without username/password.
  overrideCreds = creds ? { username: creds.username, password: creds.password } : {};
  credsGeneration += 1;
  for (const fn of listeners) {
    try { fn(override); } catch { /* listener errors must not break the setter */ }
  }
}

// Wave 5.62 — label-only refresh for the active-target singleton. The label is
// a presentation field surfaced by `GET /redis/active-target` (consumed by the
// UI pill). Renaming the active profile must update the pill but MUST NOT bump
// `credsGeneration` (no client rebuild needed — same Redis) and MUST NOT fire
// listeners (the bootstrap scheduler subscribes here and would otherwise flip
// the status banner to "Bootstrapping…" on a pure rename). No-op when there's
// no override (e.g. fallback to REDIS_URL): there is no caller-installed label
// to mutate, and the env-derived label is computed on read.
export function setActiveTargetLabel(label: string): void {
  if (!override) return;
  override = { ...override, label };
}

export function resetActiveTarget(): void {
  override = undefined;
  overrideCreds = {};
  if (cachedBootClient) {
    try { cachedBootClient.disconnect(); } catch { /* ignore */ }
  }
  cachedBootClient = null;
  cachedBootClientKey = "";
  // Wave 6.21 — tear down every pool member; subsequent acquisitions rebuild
  // lazily against the (now-default) target.
  for (const pool of [heavyPool, lightPool]) {
    for (const m of pool.members) {
      if (m.client) {
        try { m.client.disconnect(); } catch { /* ignore */ }
      }
      m.client = null;
      m.wrapper = null;
      m.key = "";
    }
    pool.members.length = 0;
    pool.rrIndex = 0;
  }
}

export function onActiveTargetChange(fn: ActiveTargetListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Internal factory shared by the boot and runtime client accessors. The only
// per-call difference is `commandTimeout`; everything else (host, port, db,
// tls, creds, keepAlive, connectTimeout) is identical so a profile switch
// rebuilds both caches in lockstep via `targetKey(...)`.
function buildClient(
  t: ActiveTarget,
  c: ActiveTargetCreds,
  commandTimeout: number,
): Redis {
  return new Redis({
    host: t.host,
    port: t.port,
    db: t.db,
    tls: t.tls ? {} : undefined,
    ...(c.username ? { username: c.username } : {}),
    ...(c.password ? { password: c.password } : {}),
    lazyConnect: true,
    // Wave 6.23 — fast-fail rather than silently retry. ioredis's default
    // (20) re-queues commands behind the scenes while a member is degraded,
    // hiding the failure from the route handler until the cumulative latency
    // explodes. Dropping to 1 surfaces the error on the very next command so
    // the route returns a clean recoverable status (and the future 6.22
    // circuit breaker can trip without waiting for a retry storm).
    maxRetriesPerRequest: 1,
    // Wave 6.23 — disable ioredis's unbounded offline queue. With the queue
    // on (default true), commands issued while the connection is down or
    // reconnecting accumulate in memory and all dispatch when it returns,
    // amplifying the recovery spike. enableOfflineQueue:false makes those
    // commands reject immediately — the route surfaces a fast 5xx instead
    // of holding the request open until a delayed flush drains.
    enableOfflineQueue: false,
    // Wave 6.18a — TCP keepAlive so sockets surviving long idle windows on
    // Redis Enterprise proxies do not zombie into MaxRetriesPerRequestError
    // without recovering until the process restarts.
    keepAlive: 30_000,
    // Wave 6.18c — bounded connect timeout so a wedged proxy can't hang
    // `bootstrapFrtb()` and prevent `app.listen()` from binding.
    connectTimeout: 5_000,
    commandTimeout,
  });
}

// Returns a lazyConnect ioredis client bound to the current active target,
// using the Wave 6.18c boot-protection commandTimeout (10s). Cached and
// rebuilt when the target identity (host/port/tls/db) OR the stored
// credentials change so callers (boot `bootstrapFrtb`, `scheduleBootstrap`)
// get a stable instance between switches but authenticated targets don't
// trip NOAUTH.
//
// Wave 6.18f — this remains the BOOT client. Route handlers should call
// `getActiveRedisRuntimeClient()` so per-request calls can outlast the
// in-Redis 30s TIMEOUT directive instead of being aborted at 10s.
//
// Wave 6.21 — intentionally still a SINGLETON. The boot path is a single,
// infrequent call (one bootstrapFrtb per profile-switch); pooling it would
// open N×commandTimeout=10s sockets for no benefit. The runtime pools below
// are where blast-radius reduction matters.
export function getActiveRedisClient(): Redis | null {
  const t = getActiveTarget();
  const c = overrideCreds;
  const key = targetKey(t);
  if (cachedBootClient && key === cachedBootClientKey) return cachedBootClient;
  if (cachedBootClient) {
    try { cachedBootClient.disconnect(); } catch { /* ignore */ }
  }
  cachedBootClient = buildClient(t, c, BOOT_COMMAND_TIMEOUT_MS);
  cachedBootClientKey = key;
  return cachedBootClient;
}

// Wave 6.18f / 6.21 — runtime variant of `getActiveRedisClient()` used by
// per-route handlers. Identical to the boot client except:
//   * `commandTimeout` is 35_000 (overridable via
//     `RUNTIME_REDIS_COMMAND_TIMEOUT_MS`), which comfortably exceeds the
//     in-Redis FT_AGGREGATE TIMEOUT directive (`FT_AGGREGATE_TIMEOUT_MS =
//     30_000` in src/sbm/aggregate-via-index.ts).
//   * Backed by ONE OF TWO pools (heavy / light, default size 4 each)
//     selected round-robin so a single hung command does not stall unrelated
//     routes. Category defaults to `"heavy"` so any caller that hasn't
//     explicitly opted in to `"light"` keeps the safest fallback.
// VM evidence on bigcluster (calc-discovery-failed × 24, all at exactly 10s)
// showed routes being aborted by the boot-protection ioredis 10s timeout
// before Redis itself had a chance to emit its 30s TIMEOUT error — clients
// then saw a generic command-timeout instead of a clean recoverable error.
// 35s = 30s in-Redis budget + 5s grace; still capped so genuinely hung
// commands cannot wedge the request forever.
//
// The 2026-06-17 incident demonstrated the second failure mode: with a single
// shared runtime client, one slow FT.AGGREGATE held the socket and every
// unrelated /observability call queued behind it. The "reconnect to make it
// fast" UX workaround was operators tearing down the singleton. The pool
// turns that workaround into a built-in behaviour — slow work lands on one
// member, the other three keep the snapshot UI responsive.
export function getActiveRedisRuntimeClient(category: RuntimeCategory = "heavy"): Redis | null {
  const pool = category === "light" ? lightPool : heavyPool;
  const envName = category === "light"
    ? "RUNTIME_REDIS_POOL_SIZE_LIGHT"
    : "RUNTIME_REDIS_POOL_SIZE_HEAVY";
  return acquireFromPool(pool, envName);
}

// Resize the pool's slot array to `size`. Grows by appending empty slots
// (lazy-built on first acquisition); shrinks by disconnecting and dropping
// surplus members so a runtime env tweak that lowers the pool size releases
// the extra sockets next time around.
function ensurePoolSized(pool: Pool, size: number): void {
  if (pool.members.length === size) return;
  if (pool.members.length < size) {
    while (pool.members.length < size) {
      pool.members.push({ client: null, wrapper: null, key: "" });
    }
    return;
  }
  for (const m of pool.members.slice(size)) {
    if (m.client) {
      try { m.client.disconnect(); } catch { /* ignore */ }
    }
  }
  pool.members.length = size;
  if (pool.rrIndex >= size) pool.rrIndex = 0;
}

// Round-robin acquisition. Picks the next slot, rebuilds if its `key`
// disagrees with the current `targetKey(...)` (setActiveTarget rotation) OR
// if the slot was previously marked stale by the recycle hook. Returns the
// recycle-aware Proxy wrapper, NOT the raw ioredis client, so callers
// automatically participate in the per-member self-heal flow.
function acquireFromPool(pool: Pool, sizeEnvName: string): Redis | null {
  const t = getActiveTarget();
  const c = overrideCreds;
  const key = targetKey(t);
  ensurePoolSized(pool, getPoolSize(sizeEnvName));
  if (pool.members.length === 0) return null;

  const idx = pool.rrIndex;
  pool.rrIndex = (pool.rrIndex + 1) % pool.members.length;
  const member = pool.members[idx]!;

  if (member.client && member.wrapper && member.key === key) {
    return member.wrapper;
  }
  if (member.client) {
    try { member.client.disconnect(); } catch { /* ignore */ }
  }
  const built = runtimeClientFactoryForTests
    ? runtimeClientFactoryForTests(t, c, getRuntimeCommandTimeoutMs())
    : buildClient(t, c, getRuntimeCommandTimeoutMs());
  attachErrorRecycle(built, member);
  member.client = built;
  member.wrapper = wrapWithRecycle(built, member);
  member.key = key;
  return member.wrapper;
}

// Inspect an error and decide whether the member that surfaced it should be
// torn down. Matches the connection-level codes that almost always indicate a
// poisoned socket, plus the ioredis `commandTimeout`-induced "Command timed
// out" message that signals the in-Redis budget was exhausted on this socket.
function shouldRecycle(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "ETIMEDOUT" || e.code === "ECONNRESET" || e.code === "EPIPE") return true;
  const msg = typeof e.message === "string" ? e.message : String(err);
  return msg.includes("Command timed out");
}

// Mark `member` stale so the next round-robin pick rebuilds it. Idempotent
// across the two recycle entry points (the `on('error')` socket hook AND the
// Proxy-wrapper rejection hook) — both compare `member.client === client`
// before tearing down so a slot that's already been rotated to a fresh client
// is not accidentally re-cleared.
function recyclePoolMember(member: PoolMember, client: Redis): void {
  if (member.client !== client) return;
  member.client = null;
  member.wrapper = null;
  member.key = "";
  try { client.disconnect(); } catch { /* ignore */ }
}

// Subscribe to ioredis's connection-level `error` channel so a socket that
// transitions to ETIMEDOUT/ECONNRESET/EPIPE outside of an in-flight command
// (mid-reconnect bursts, idle keepalive failures) still trips the recycle
// path. Wave 6.23's `enableOfflineQueue:false` keeps these errors loud
// instead of silently queued, so we MUST install a listener — without one,
// node would treat the emitted error as unhandled.
function attachErrorRecycle(client: Redis, member: PoolMember): void {
  client.on("error", (err: unknown) => {
    if (shouldRecycle(err)) recyclePoolMember(member, client);
  });
}

// Wrap the ioredis client in a Proxy that mirrors every property access but
// intercepts the promise returned by each method call. When a command
// rejects with a recycle-worthy error, the pool slot is marked stale BEFORE
// the rejection propagates to the route handler — so the very next request
// for this slot rebuilds rather than re-using the poisoned socket. The
// rejection still reaches the caller unchanged (we re-throw via `throw err`).
function wrapWithRecycle(client: Redis, member: PoolMember): Redis {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function wrapped(...args: unknown[]): unknown {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (out && typeof (out as Promise<unknown>).then === "function") {
          return (out as Promise<unknown>).then(
            (v) => v,
            (err) => {
              if (shouldRecycle(err)) recyclePoolMember(member, client);
              throw err;
            },
          );
        }
        return out;
      };
    },
  }) as Redis;
}

// Test seam — install a fake client factory so unit tests in
// `runtime-pool.test.ts` can build pool members without opening real TCP
// sockets and assert round-robin / recycle / lockstep-invalidation
// behaviour. Pass `null` to restore the production `buildClient(...)` path.
export function __setRuntimeClientFactoryForTests(
  fn:
    | ((t: ActiveTarget, c: ActiveTargetCreds, commandTimeout: number) => Redis)
    | null,
): void {
  runtimeClientFactoryForTests = fn;
}

// Test seam — exposes a structured view of a pool so unit tests can assert
// pool size, member identity, key liveness, and rrIndex without poking at
// module-internal state. Returns a snapshot; mutation is intentionally
// disabled (slots are spread into a fresh array of value copies).
export function __getRuntimePoolForTests(category: RuntimeCategory): {
  members: { client: Redis | null; wrapper: Redis | null; key: string }[];
  rrIndex: number;
} {
  const pool = category === "light" ? lightPool : heavyPool;
  return {
    members: pool.members.map((m) => ({ client: m.client, wrapper: m.wrapper, key: m.key })),
    rrIndex: pool.rrIndex,
  };
}

export function getActiveTarget(): ActiveTarget {
  if (override) return override;
  const url = process.env.REDIS_URL;
  if (url) return parseRedisUrl(url);
  return { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "default" };
}

function parseRedisUrl(raw: string): ActiveTarget {
  try {
    const u = new URL(raw);
    const tls = u.protocol === "rediss:" || u.protocol === "rediss";
    const port = u.port ? Number(u.port) : tls ? 6379 : 6379;
    const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) || 0 : 0;
    return { host: u.hostname || "127.0.0.1", port, tls, db, label: "env:REDIS_URL" };
  } catch {
    return { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "env:REDIS_URL" };
  }
}
