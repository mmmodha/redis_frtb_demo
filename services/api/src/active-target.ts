// Active Redis target singleton.
//
// Other services (ingest, generator, source, calc, loadgen) and our own
// endpoints obtain the current target via `GET /redis/active-target`. The
// Connections store agent (task c496f7e8) will set the active target on
// profile-switch via `setActiveTarget(...)`. With no override, we fall back
// to the REDIS_URL env var, then to localhost — keeping CI / unit tests
// trivially configurable.

import { randomUUID } from "node:crypto";
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
// Wave 6.21 — multiple kinds of client live behind this module, all identical
// host/port/auth/keepalive but with different per-command timeouts AND
// different multiplicity:
//   * `cachedBootClient` — commandTimeout: 10_000 (Wave 6.18c). SINGLETON.
//     Used by the api boot path (`bootstrapFrtb` + post-listen
//     `scheduleBootstrap`) so a wedged Redis Enterprise proxy fails fast and
//     `app.listen(...)` is reached. Companion to `withBootTimeout(...)` in
//     index.ts (12s). Intentionally NOT pooled: the boot path is a single,
//     infrequent call; a singleton avoids opening N sockets just to bootstrap.
//   * `heavyCalcPool` — POOL of `RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC` (default
//     4) ioredis clients selected round-robin. Used for slow per-request calc
//     work (FT.AGGREGATE, FCALL, /calc/sbm, /pivot, /facets, /suggest, snapshot
//     and drift jobs). Wave 6.40.X — split out of the prior unified `heavyPool`
//     so a calc burst can no longer monopolise the heavy slot population and
//     starve ingest writes.
//   * `heavyIngestPool` — POOL of `RUNTIME_REDIS_POOL_SIZE_HEAVY_INGEST`
//     (default 4). Used for API-side ingest writers (XADD producers via
//     /generator/start, /admin/rebuild-indexes when it MKSTREAMs the ingest
//     stream, /admin/flush). Independent failure domain from heavyCalcPool —
//     all members of one going `open` does NOT affect the other. The ingest
//     SERVICE (`services/ingest/src/consumer.ts`) is unaffected: it owns its
//     own client via `services/ingest/src/shard-runtime.ts`. Both heavy pools
//     resolve via `getActiveTarget()` to the SAME host/port/creds; the split
//     is operational (size, timeout, circuit) not topological — that's a
//     follow-up wave once divergent ingest/calc targets are needed.
//   * `lightPool` — POOL of `RUNTIME_REDIS_POOL_SIZE_LIGHT` (default 4)
//     ioredis clients selected round-robin. Used for cheap reads
//     (observability, /admin/preflight, healthz-adjacent endpoints) so a
//     poisoned heavy connection from a slow FT.AGGREGATE cannot push the
//     snapshot/health UI to multi-second latencies. Independent from both
//     heavy pools.
// All four share the same `targetKey(...)` cache invalidation so
// `setActiveTarget` rebuilds the boot singleton AND every pool member in
// lockstep (lazily — each slot rebuilds on its next acquisition with the new
// key). Per-member recycle (see `wrapWithRecycle`) marks individual pool
// members stale on command timeouts / ETIMEDOUT / ECONNRESET / EPIPE so a
// poisoned socket self-heals without taking down its peers.
//
// Wave 6.22 — each member additionally carries a small circuit breaker on
// top of the recycle hook. The breaker counts CONSECUTIVE failures (a
// successful command resets the counter); reaching `POOL_MEMBER_FAILURE_
// THRESHOLD` flips the circuit `closed → open` and disconnects the socket.
// `acquireFromPool` skips open members during round-robin and returns the
// next live one. When every member in a pool is open, the oldest one
// transitions to `half-open` after `CIRCUIT_BACKOFF_MS`, gets a fresh
// `buildClient(...)`, and either closes (on the first successful command)
// or re-opens (on the next failure) for another backoff window. State
// transitions are emitted as structured `pool-circuit-*` logs so a future
// observability dashboard can wire in without re-instrumenting the pool.
let cachedBootClient: Redis | null = null;
let cachedBootClientKey = "";

const BOOT_COMMAND_TIMEOUT_MS = 10_000;
const RUNTIME_COMMAND_TIMEOUT_DEFAULT_MS = 35_000;
const RUNTIME_POOL_SIZE_DEFAULT = 4;

// Wave 6.22 — per-member circuit breaker thresholds. `failureThreshold` is the
// consecutive-failure count that flips a member from `closed` → `open`; a
// successful command anywhere along the way resets the counter (it must be
// CONSECUTIVE failures, not cumulative). `backoffMs` is the minimum wall-clock
// window an open circuit stays open before the round-robin will consider it
// for a half-open probe rebuild. Defaults match the 6.22 spec; both are
// env-overridable so an operator can shorten / lengthen the window without
// shipping new code.
const POOL_MEMBER_FAILURE_THRESHOLD_DEFAULT = 3;
const CIRCUIT_BACKOFF_DEFAULT_MS = 5_000;

// Wave 6.30.B4 / 6.40.X — per-command timeout (Option A) wrapped around each
// pool dispatch via the recycle Proxy. Three independent budgets:
//   * heavy-calc:   35s — FT.AGGREGATE / FCALL / SBM pipelines that touch the
//     100M-row sensitivity index need to outlast the in-Redis 30s
//     FT_AGGREGATE TIMEOUT directive so the engine error surfaces first.
//   * heavy-ingest: 5s — XADD producers + MKSTREAM ops fast-fail so a stuck
//     write surfaces before it backs up the consumer.
//   * light:        1.5s — observability / preflight should never take longer.
// All three env-overridable so an operator can tighten/loosen the window
// without shipping new code. The legacy `POOL_COMMAND_TIMEOUT_HEAVY_MS`
// remains as a backward-compatible fallback feeding the heavy-calc pool
// (and therefore the `"heavy"` deprecated alias).
const POOL_COMMAND_TIMEOUT_HEAVY_CALC_DEFAULT_MS = 35_000;
const POOL_COMMAND_TIMEOUT_HEAVY_INGEST_DEFAULT_MS = 5_000;
const POOL_COMMAND_TIMEOUT_LIGHT_DEFAULT_MS = 1_500;

// Wave 6.30.B4 — scheduled half-open probe backoff. Once a member opens, a
// background timer fires after `initial` to issue a single PING via the
// wrapper; success closes the circuit, failure doubles the next delay up to
// `cap`. 10s start gives a poisoned cluster time to recover before we burn
// another rebuild; 5min cap prevents an indefinitely-down member from
// spinning rebuilds forever.
const HALF_OPEN_INITIAL_BACKOFF_DEFAULT_MS = 10_000;
const HALF_OPEN_BACKOFF_CAP_DEFAULT_MS = 300_000;

// Wave 6.30.B4 — Option C: fatal-error-pattern fast-trip. These message
// fragments unambiguously indicate a wedged socket (the 2026-06-17 incident's
// `Command timed out` + sibling `Stream isn't writeable` from Wave 6.23's
// offline-queue-off path). The wrapper's own per-command timeout synthesises
// a `pool-command-fail-fast` error which is also matched here. On a closed
// circuit, any of these tripping a single time flips the breaker straight to
// open (consecutive_failures=1) instead of waiting for the configured
// threshold — eliminates the ~105s detection window the incident exposed.
const FATAL_ERROR_PATTERN = /Command timed out|Stream isn'?t writeable|pool-command-fail-fast/;

function getFailureThreshold(): number {
  const raw = process.env.POOL_MEMBER_FAILURE_THRESHOLD;
  if (raw === undefined || raw === "") return POOL_MEMBER_FAILURE_THRESHOLD_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : POOL_MEMBER_FAILURE_THRESHOLD_DEFAULT;
}

function getCircuitBackoffMs(): number {
  const raw = process.env.CIRCUIT_BACKOFF_MS;
  if (raw === undefined || raw === "") return CIRCUIT_BACKOFF_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CIRCUIT_BACKOFF_DEFAULT_MS;
}

// Read a positive-integer ms env var, falling back when unset/invalid.
function readMsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Wave 6.40.X — pool category drives both the per-command race timeout and
// the env-var lookup chain. heavy-calc reads its dedicated var first, then
// falls back to the legacy `POOL_COMMAND_TIMEOUT_HEAVY_MS` (so operators
// who already tuned the unified heavy pool keep the same dial), then the
// default. heavy-ingest has no legacy fallback — it's a new pool.
function getCommandTimeoutMs(category: NormalizedCategory): number {
  if (category === "light") {
    return readMsEnv("POOL_COMMAND_TIMEOUT_LIGHT_MS", POOL_COMMAND_TIMEOUT_LIGHT_DEFAULT_MS);
  }
  if (category === "heavy-ingest") {
    return readMsEnv(
      "POOL_COMMAND_TIMEOUT_HEAVY_INGEST_MS",
      POOL_COMMAND_TIMEOUT_HEAVY_INGEST_DEFAULT_MS,
    );
  }
  const direct = process.env.POOL_COMMAND_TIMEOUT_HEAVY_CALC_MS;
  if (direct !== undefined && direct !== "") {
    const n = Number(direct);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return readMsEnv(
    "POOL_COMMAND_TIMEOUT_HEAVY_MS",
    POOL_COMMAND_TIMEOUT_HEAVY_CALC_DEFAULT_MS,
  );
}

function getHalfOpenInitialBackoffMs(): number {
  const raw = process.env.HALF_OPEN_INITIAL_BACKOFF_MS;
  if (raw === undefined || raw === "") return HALF_OPEN_INITIAL_BACKOFF_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : HALF_OPEN_INITIAL_BACKOFF_DEFAULT_MS;
}

function getHalfOpenBackoffCapMs(): number {
  const raw = process.env.HALF_OPEN_BACKOFF_CAP_MS;
  if (raw === undefined || raw === "") return HALF_OPEN_BACKOFF_CAP_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HALF_OPEN_BACKOFF_CAP_DEFAULT_MS;
}

function isFatalErrorPattern(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: unknown };
  const msg = typeof e.message === "string" ? e.message : String(err);
  return FATAL_ERROR_PATTERN.test(msg);
}

// Public category label for the runtime pools.
//   * `"heavy-calc"`   — FT.AGGREGATE / FCALL / SBM / pivot / facets / suggest.
//   * `"heavy-ingest"` — XADD producers, MKSTREAM, ingest-stream maintenance.
//   * `"light"`        — observability / preflight / healthz-adjacent reads.
//   * `"heavy"`        — DEPRECATED alias for `"heavy-calc"`. Wave 6.40.X kept
//     the label so unmigrated callers still get a sensible pool; the first
//     use per process emits a one-shot `pool-category-alias` warning so the
//     migration progress is visible without log spam.
export type RuntimeCategory = "heavy-calc" | "heavy-ingest" | "light" | "heavy";

// Wave 6.40.X — internal three-value form used by pool selection and env
// lookup. `normalizeCategory("heavy")` returns `"heavy-calc"` AFTER emitting
// the alias warn so every internal switch is exhaustive on the three real
// categories without each call site re-checking for the alias. Exported so
// the structured `PoolEventPayload.category` field can advertise a closed
// alphabet (no `"heavy"` ever escapes the emitter).
export type NormalizedCategory = "heavy-calc" | "heavy-ingest" | "light";

let aliasWarnEmitted = false;
function normalizeCategory(category: RuntimeCategory): NormalizedCategory {
  if (category === "heavy") {
    if (!aliasWarnEmitted) {
      aliasWarnEmitted = true;
      // Use the same console-based fallback the pool event sink uses so this
      // never breaks under vitest (NODE_ENV=test silences it) but is loud
      // enough in production logs that operators can drive the migration.
      try {
        if (process.env.NODE_ENV !== "test") {
          // eslint-disable-next-line no-console
          console.warn(JSON.stringify({
            evt: "pool-category-alias",
            category: "heavy",
            mapped_to: "heavy-calc",
            msg: "deprecated RuntimeCategory \"heavy\"; route to \"heavy-calc\" or \"heavy-ingest\" explicitly",
          }));
        }
      } catch { /* sink must never break the pool path */ }
    }
    return "heavy-calc";
  }
  return category;
}

// Test seam — reset the alias warn so unit tests can observe the one-shot
// emission contract without process restart.
export function __resetAliasWarnForTests(): void {
  aliasWarnEmitted = false;
}

// Wave 6.21 (M1) — stable identity surface for pool members. Format is
// `${category}:${index}` (e.g. `heavy:0`, `light:3`); the index is the slot
// number and stays stable across rebuilds so structured logs emitted in
// future waves (6.22 auto-recycle observability) can correlate "the
// connection that timed out twice" across rebuilds. `createdAt` and
// `generation` change on every rebuild so an operator can tell whether the
// `heavy:0` they're looking at is the original or a self-healed instance.
export interface PoolMemberInfo {
  id: string;
  createdAt: number;
  generation: number;
}

// Wave 6.22 — per-member circuit breaker state.
//   * `closed`    → normal operation; failures increment `consecutiveFailures`
//   * `open`      → member skipped by round-robin; commands route elsewhere
//   * `half-open` → probe rebuild in flight; the next command's outcome
//                   decides closed (success) or open (failure)
export type CircuitState = "closed" | "open" | "half-open";

interface PoolMember {
  // Stable per-slot identifier. Set once at slot creation and reused across
  // every rebuild of the underlying client so log lines stay correlatable
  // even as the socket is swapped out underneath.
  readonly id: string;
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
  // Wall-clock instant the current `client` was constructed. Reset on every
  // rebuild; useful when 6.22's auto-recycle logger wants to surface "this
  // socket was created N ms ago and already timed out".
  createdAt: number;
  // Monotonic per-slot rebuild counter. Starts at 0 (no build yet),
  // increments on each lazy rebuild (key mismatch, recycle, drain swap).
  // Pairs with `id` to form a globally unique log key `${id}#${generation}`.
  generation: number;
  // Wave 6.22 — circuit breaker state machine. `consecutiveFailures` resets
  // on the first successful command; reaching the threshold flips
  // `circuitState` to `open` and records `openedAt`. Round-robin treats
  // `open` and `half-open` as "skip when alternatives exist". After
  // `CIRCUIT_BACKOFF_MS` elapses, the oldest open member is eligible for a
  // half-open probe rebuild (`acquireFromPool` handles this when every other
  // member is also open).
  consecutiveFailures: number;
  circuitState: CircuitState;
  openedAt: number;
  // Wave 6.30.B4 — scheduled half-open probe backoff state. `currentBackoffMs`
  // tracks how long the next probe should wait (10s on the first open, doubled
  // on each probe failure, capped at 5min). `probeTimer` holds the active
  // setTimeout handle so a target swap / teardown can cancel it without
  // leaking timers or surprising the test runner with a late rebuild.
  currentBackoffMs: number;
  probeTimer: ReturnType<typeof setTimeout> | null;
}

interface Pool {
  readonly category: NormalizedCategory;
  members: PoolMember[];
  rrIndex: number;
}

const heavyCalcPool: Pool = { category: "heavy-calc", members: [], rrIndex: 0 };
const heavyIngestPool: Pool = { category: "heavy-ingest", members: [], rrIndex: 0 };
const lightPool: Pool = { category: "light", members: [], rrIndex: 0 };

// Wave 6.40.X — iterate every runtime pool (used by target-swap detach,
// resetActiveTarget teardown, readiness probe). Order is stable so test
// snapshots can rely on it.
const allPools: readonly Pool[] = [heavyCalcPool, heavyIngestPool, lightPool];

function poolForNormalized(category: NormalizedCategory): Pool {
  if (category === "light") return lightPool;
  if (category === "heavy-ingest") return heavyIngestPool;
  return heavyCalcPool;
}

// Wave 6.21 (M6) — grace window during which an old pool member keeps
// serving in-flight commands after a `setActiveTarget` swap. Default 500ms,
// env-overridable. The OLD client is detached from the pool immediately
// (every NEW acquisition routes to a freshly built client against the new
// target) but `disconnect()` is deferred so a calc mid-flight is not aborted
// when the operator clicks "Reconnect". `resetActiveTarget()` (test
// teardown) bypasses the grace — see the resetActiveTarget body for why.
const POOL_DRAIN_GRACE_DEFAULT_MS = 500;

function getPoolDrainGraceMs(): number {
  const raw = process.env.RUNTIME_REDIS_POOL_DRAIN_GRACE_MS;
  if (raw === undefined || raw === "") return POOL_DRAIN_GRACE_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : POOL_DRAIN_GRACE_DEFAULT_MS;
}

// Clients detached by `setActiveTarget` but not yet disconnected. Kept in a
// set so `resetActiveTarget()` (and tests) can drain them immediately on
// teardown rather than leaving timers + sockets hanging until the grace
// window elapses.
const drainingClients = new Set<Redis>();

// Wave 6.26 — `/readyz` runtime-pool readiness probe state.
//
// Background: the boot-protection client (`cachedBootClient`) finishes its
// handshake during `bootstrapFrtb()`, and `markBootstrapReady()` flips the
// `/readyz` gate on that signal. The runtime pool members below, however,
// are built lazily on first `acquireFromPool(...)` and use
// `enableOfflineQueue:false` + `maxRetriesPerRequest:1` — so the very first
// request after `/readyz` reports ready can land on a member whose TCP/TLS
// handshake (or cluster topology discovery) hasn't completed and surface as
// `ReplyError: Stream isn't writeable`. The probe below issues a single
// `PING` per slot in each pool, caches the verdict for 250ms (so /readyz
// polling at >4Hz cannot hammer Redis), and de-dups concurrent invocations
// behind a single in-flight Promise. `setActiveTarget` / `resetActiveTarget`
// clear the cache so a profile switch can't keep a stale `ok:true` alive.
const RUNTIME_READINESS_CACHE_MS = 250;
interface RuntimeReadinessVerdict { ok: boolean; err?: string; }
interface RuntimeReadinessCache extends RuntimeReadinessVerdict { ts: number; }
let runtimeReadinessCache: RuntimeReadinessCache | null = null;
let runtimeReadinessInFlight: Promise<RuntimeReadinessVerdict> | null = null;

// Test seam: replaces the per-member `Redis` factory so unit tests can drive
// pool behaviour (round-robin distribution, recycle on simulated timeout,
// independent pools) without opening real sockets. Production keeps this null
// and `buildClient(...)` is used.
let runtimeClientFactoryForTests:
  | ((t: ActiveTarget, c: ActiveTargetCreds, opts: BuildClientOpts) => Redis)
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

// Wave 6.43.B.1 — monotonically-increasing version of the active target,
// bumped on every successful commit inside `setActiveTarget`. Surfaced via
// `GET /internal/redis/active-target/full` so pollers (source, loadgen)
// detect identity changes without diffing every field. Lives here (not in
// internal-target.ts) so the switch coordinator can include `version+1` in
// the prepare HTTP push payload without an awkward back-import.
let activeTargetVersion = 1;

export function getActiveTargetVersion(): number {
  return activeTargetVersion;
}

// Test seam — reset the version counter to 1 so tests can assert exact values.
export function __resetActiveTargetVersionForTests(): void {
  activeTargetVersion = 1;
}

// Wave 6.43.B.1 — switch coordinator. The api orchestrates a two-phase
// prepare/commit handoff: parallel HTTP POST to each KNOWN_SERVICES endpoint
// (`/admin/active-target/prepare`), wait for each service to either ACK
// `drained` (via the push response OR `/internal/redis/active-target/ack`)
// or the drain timeout to elapse, commit the identity swap, then parallel
// HTTP POST to each service's `/admin/active-target/commit`. State is
// per-switch and keyed on a `switch_id` so a late ACK from a superseded
// switch can be rejected with 409. HTTP errors (4xx/5xx/network) record
// `push_failed` for that service and NEVER fail the switch — the 2.5s HTTP
// polling fallback at `/internal/redis/active-target/full` covers the gap.

const SWITCH_DRAIN_TIMEOUT_DEFAULT_MS = 10_000;
// Wave 6.56.D3.re-fix — raised 5_000 → 30_000 to match ingest's own drain
// budget. Wave 6.44.V.re4 verification proved 5s is still too short under
// the S2 (steady-state + switch) and S4 (rapid 5x switches) scenarios: the
// initial push aborts at 5s, the D3 retry-once (which gets its own fresh
// AbortController + timer per call via `pushSwitchEvent`) also fires inside
// the same overloaded window and aborts again, yielding
// `per_service[ingest] push_failed: "This operation was aborted"` even
// though ingest's internal `active-target prepare drain timed out` log
// shows it uses `timeout_ms: 30000`. Aligning the api budget with ingest's
// drain budget eliminates the spurious abort. The happy path still
// resolves in <1s; only the bottlenecked path gets the headroom.
// must exceed ingest drain budget (30s) to avoid co-timeout race — Wave 6.57.A
const SWITCH_PUSH_TIMEOUT_DEFAULT_MS = 60_000;
const DEFAULT_KNOWN_SERVICES = "ingest,source,loadgen";
const DEFAULT_INTERNAL_API_TOKEN = "dev-internal-token";
const DEFAULT_SERVICE_HOST = "127.0.0.1";
const DEFAULT_SERVICE_PORTS: Readonly<Record<string, number>> = {
  ingest: 8083,
  source: 8082,
  loadgen: 8085,
};

export type ServiceSwitchPhase =
  | "pending"
  | "drained"
  | "committed"
  | "drain_timeout"
  | "push_failed"
  | "error";

export type SwitchPhase =
  | "idle"
  | "prepare"
  | "draining"
  | "committed";

export interface ServiceSwitchState {
  name: string;
  phase: ServiceSwitchPhase;
  drained_at?: number;
  committed_at?: number;
  error?: string;
}

export interface SwitchStatus {
  current_switch_id: string | null;
  phase: SwitchPhase;
  per_service: ServiceSwitchState[];
}

export interface SwitchAckInput {
  switch_id: string;
  service: string;
  phase: "drained" | "committed";
  ok: boolean;
  error?: string;
}

// Known-service registry entry resolved from `KNOWN_SERVICES` env. Each name
// gets a host (`${NAME}_HOST` or DEFAULT_SERVICE_HOST) and a port
// (`${NAME}_PORT` or the DEFAULT_SERVICE_PORTS table). Names not present in
// the defaults table fall through to port 0 — the HTTP push will fail
// immediately and record push_failed.
export interface KnownService {
  name: string;
  host: string;
  port: number;
}

// Payload sent on every HTTP push. `target` carries the same identity fields
// the pre-6.43 pub/sub payload's `next` did so subscribers don't have to
// re-derive them. `t` is the api-side wall-clock at push time — useful for
// latency attribution in service logs.
export interface SwitchPushPayload {
  switch_id: string;
  phase: "prepare" | "commit";
  target: { label: string; version: number };
  t: number;
}

interface SwitchRecord {
  switch_id: string;
  startedAt: number;
  next: { label: string; version: number };
  phase: SwitchPhase;
  perService: Map<string, ServiceSwitchState>;
  drainNotify?: () => void;
}

let currentSwitch: SwitchRecord | null = null;
// Past switch_ids retained so a late ACK that names a stale switch can be
// rejected with 409 `superseded` rather than silently coerced into the
// current switch. Bounded — only keep the most recent N to avoid unbounded
// growth in long-running processes.
const priorSwitchIds = new Set<string>();
const PRIOR_SWITCH_HISTORY_MAX = 64;

function getSwitchDrainTimeoutMs(): number {
  const raw = process.env.SWITCH_DRAIN_TIMEOUT_MS;
  if (raw === undefined || raw === "") return SWITCH_DRAIN_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SWITCH_DRAIN_TIMEOUT_DEFAULT_MS;
}

function getSwitchPushTimeoutMs(): number {
  const raw = process.env.SWITCH_PUSH_TIMEOUT_MS;
  if (raw === undefined || raw === "") return SWITCH_PUSH_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SWITCH_PUSH_TIMEOUT_DEFAULT_MS;
}

function resolveKnownService(name: string): KnownService {
  const upper = name.toUpperCase();
  const hostEnv = process.env[`${upper}_HOST`];
  const portEnvRaw = process.env[`${upper}_PORT`];
  const portEnv = portEnvRaw ? Number(portEnvRaw) : undefined;
  const port = Number.isFinite(portEnv) && (portEnv as number) > 0
    ? Math.floor(portEnv as number)
    : (DEFAULT_SERVICE_PORTS[name] ?? 0);
  const host = hostEnv && hostEnv.length > 0 ? hostEnv : DEFAULT_SERVICE_HOST;
  return { name, host, port };
}

function getKnownServices(): KnownService[] {
  const raw = process.env.KNOWN_SERVICES ?? DEFAULT_KNOWN_SERVICES;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(resolveKnownService);
}

// Test seam — replace the per-service HTTP push with a fake so unit tests can
// drive the coordinator without binding sockets. Pass `null` to restore the
// production path (real `fetch(...)`).
export type SwitchPusher = (
  service: KnownService,
  phase: "prepare" | "commit",
  payload: SwitchPushPayload,
) => Promise<Response>;

let switchPusherForTests: SwitchPusher | null = null;

export function __setSwitchPusherForTests(fn: SwitchPusher | null): void {
  switchPusherForTests = fn;
}

// Test seam — wipe the switch registry so tests start from a clean slate.
export function __resetSwitchStateForTests(): void {
  if (currentSwitch?.drainNotify) {
    currentSwitch.drainNotify = undefined;
  }
  currentSwitch = null;
  priorSwitchIds.clear();
}

export function getSwitchStatus(): SwitchStatus {
  if (!currentSwitch) {
    return { current_switch_id: null, phase: "idle", per_service: [] };
  }
  return {
    current_switch_id: currentSwitch.switch_id,
    phase: currentSwitch.phase,
    per_service: [...currentSwitch.perService.values()].map((sp) => ({ ...sp })),
  };
}

export type RecordSwitchAckResult =
  | { status: "ok" }
  | { status: "superseded" }
  | { status: "malformed"; reason: string };

// Apply a service-side ACK to the current switch registry. Validation is
// strict (typeof string, phase ∈ {drained,committed}, ok is boolean) so a
// garbage POST body cannot poison the in-memory state. Stale switch_ids
// (anything other than the currently-tracked switch) surface as `superseded`
// — the route layer translates that into a 409 with no state mutation.
export function recordSwitchAck(input: unknown): RecordSwitchAckResult {
  if (!input || typeof input !== "object") {
    return { status: "malformed", reason: "body must be an object" };
  }
  const body = input as Record<string, unknown>;
  if (typeof body.switch_id !== "string" || body.switch_id.length === 0) {
    return { status: "malformed", reason: "switch_id must be a non-empty string" };
  }
  if (typeof body.service !== "string" || body.service.length === 0) {
    return { status: "malformed", reason: "service must be a non-empty string" };
  }
  if (body.phase !== "drained" && body.phase !== "committed") {
    return { status: "malformed", reason: "phase must be \"drained\" or \"committed\"" };
  }
  if (typeof body.ok !== "boolean") {
    return { status: "malformed", reason: "ok must be a boolean" };
  }
  if (body.error !== undefined && typeof body.error !== "string") {
    return { status: "malformed", reason: "error must be a string when present" };
  }
  const ack: SwitchAckInput = {
    switch_id: body.switch_id,
    service: body.service,
    phase: body.phase,
    ok: body.ok,
    ...(typeof body.error === "string" ? { error: body.error } : {}),
  };
  if (!currentSwitch || currentSwitch.switch_id !== ack.switch_id) {
    return { status: "superseded" };
  }
  let sp = currentSwitch.perService.get(ack.service);
  if (!sp) {
    // A service not listed in KNOWN_SERVICES still ACKed — record it so the
    // status response surfaces every participant, but the drain wait does
    // not block on unknown services (they are not part of the initial
    // perService keyset that allDrained() iterates).
    sp = { name: ack.service, phase: "pending" };
    currentSwitch.perService.set(ack.service, sp);
  }
  const now = Date.now();
  if (!ack.ok) {
    sp.phase = "error";
    sp.error = ack.error ?? "unspecified";
  } else if (ack.phase === "drained") {
    sp.phase = "drained";
    sp.drained_at = now;
  } else {
    sp.phase = "committed";
    sp.committed_at = now;
  }
  if (currentSwitch.drainNotify) currentSwitch.drainNotify();
  return { status: "ok" };
}

function rotateSwitchHistory(nextRecord: SwitchRecord): void {
  if (currentSwitch && currentSwitch.switch_id !== nextRecord.switch_id) {
    priorSwitchIds.add(currentSwitch.switch_id);
    if (priorSwitchIds.size > PRIOR_SWITCH_HISTORY_MAX) {
      const oldest = priorSwitchIds.values().next().value as string | undefined;
      if (oldest) priorSwitchIds.delete(oldest);
    }
  }
  currentSwitch = nextRecord;
}

function allTerminallyDrained(record: SwitchRecord): boolean {
  for (const sp of record.perService.values()) {
    if (sp.phase === "pending") return false;
  }
  return true;
}

function waitForDrain(record: SwitchRecord, timeoutMs: number): Promise<void> {
  if (allTerminallyDrained(record)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.drainNotify = undefined;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    record.drainNotify = () => {
      if (allTerminallyDrained(record)) finish();
    };
  });
}

// HTTP push to a single service's `/admin/active-target/{prepare|commit}`.
// Bounded by `SWITCH_PUSH_TIMEOUT_MS` via AbortController so a hung server
// can't keep a connection open past the drain timeout. Bearer token is read
// per-call so a process that mutates `INTERNAL_API_TOKEN` after start still
// gets the new value. The caller is responsible for translating the Response
// (or thrown error) into a switch-status update.
async function pushSwitchEvent(
  service: KnownService,
  phase: "prepare" | "commit",
  payload: SwitchPushPayload,
): Promise<Response> {
  if (switchPusherForTests) return switchPusherForTests(service, phase, payload);
  const url = `http://${service.host}:${service.port}/admin/active-target/${phase}`;
  const token = process.env.INTERNAL_API_TOKEN ?? DEFAULT_INTERNAL_API_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getSwitchPushTimeoutMs());
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Apply a successful HTTP push response as the matching service ACK. Uses
// the same per-service state surface that the ACK endpoint feeds via
// `recordSwitchAck` so callers see one consistent progress view regardless
// of how the service replied. Guards enforce a strict state machine —
// `drain_timeout` / `push_failed` / `committed` are terminal and cannot be
// downgraded by a late push response arriving after the drain wait elapsed.
function applyPushAck(
  record: SwitchRecord,
  serviceName: string,
  phase: "drained" | "committed",
): void {
  if (!currentSwitch || currentSwitch.switch_id !== record.switch_id) return;
  let sp = currentSwitch.perService.get(serviceName);
  if (!sp) {
    sp = { name: serviceName, phase: "pending" };
    currentSwitch.perService.set(serviceName, sp);
  }
  const now = Date.now();
  if (phase === "drained") {
    // A drained ACK only applies to a still-pending service. If the drain
    // wait already elapsed (drain_timeout) or the service failed earlier
    // (push_failed) or already committed, the original phase stands.
    if (sp.phase !== "pending") return;
    sp.phase = "drained";
    sp.drained_at = now;
  } else {
    // committed ACK upgrades from pending / drained only; terminal failure
    // states (drain_timeout, push_failed, error) and an already-committed
    // service are NOT overwritten.
    if (sp.phase !== "pending" && sp.phase !== "drained") return;
    sp.phase = "committed";
    sp.committed_at = now;
  }
  if (currentSwitch.drainNotify) currentSwitch.drainNotify();
}

// Mark a service as `push_failed` after a 4xx/5xx/network error. Terminal:
// `allTerminallyDrained` treats it as non-pending so the drain wait can
// resolve as soon as every service has either ACKed or failed. Guarded so a
// late commit-push failure doesn't overwrite a successful drained-ACK that
// already arrived via the prepare push response.
function markPushFailed(
  record: SwitchRecord,
  serviceName: string,
  reason: string,
): void {
  if (!currentSwitch || currentSwitch.switch_id !== record.switch_id) return;
  let sp = currentSwitch.perService.get(serviceName);
  if (!sp) {
    sp = { name: serviceName, phase: "pending" };
    currentSwitch.perService.set(serviceName, sp);
  }
  // Only a still-pending service transitions to push_failed. drained /
  // committed / drain_timeout / error are all terminal for this purpose.
  if (sp.phase !== "pending") return;
  sp.phase = "push_failed";
  sp.error = reason;
  if (currentSwitch.drainNotify) currentSwitch.drainNotify();
}

function warnPushFailed(
  service: KnownService,
  phase: "prepare" | "commit",
  reason: string,
): void {
  if (process.env.NODE_ENV === "test") return;
  try {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      evt: "switch-push-failed",
      service: service.name,
      host: service.host,
      port: service.port,
      phase,
      reason,
    }));
  } catch { /* sink must never break the switch path */ }
}

// Fan out a prepare or commit push to every known service in parallel. A
// 2xx response is treated as a service ACK for `ackPhase`; any other status
// or thrown error records `push_failed` for that service. NEVER throws —
// the switch must complete even if every service is unreachable.
//
// Wave 6.56.D3 — on an AbortError (the per-push fetch timer fired before
// the service replied), retry the push exactly once. The retry is
// idempotent because each service's prepare/commit handler is keyed on
// `switch_id` and is already retry-safe.
//
// Wave 6.56.D3.re-fix — every call to `pushSwitchEvent` constructs its own
// AbortController and `setTimeout(controller.abort, SWITCH_PUSH_TIMEOUT_MS)`
// internally, so the retry below gets a FULL fresh `SWITCH_PUSH_TIMEOUT_MS`
// budget independent of the initial attempt. Combined with the 30s timeout
// default this catches the slow-path where ingest's commit
// (`shardRuntime.rebuild()` + D1 retry schedule 250+500+1000ms) runs longer
// than a single push budget under rapid back-to-back switches.
async function fanOutSwitchPush(
  services: KnownService[],
  ackPhase: "drained" | "committed",
  payload: SwitchPushPayload,
  record: SwitchRecord,
): Promise<void> {
  await Promise.all(services.map(async (svc) => {
    try {
      let res: Response;
      try {
        res = await pushSwitchEvent(svc, payload.phase, payload);
      } catch (firstErr) {
        if (isAbortError(firstErr)) {
          res = await pushSwitchEvent(svc, payload.phase, payload);
        } else {
          throw firstErr;
        }
      }
      if (res.ok) {
        applyPushAck(record, svc.name, ackPhase);
      } else {
        const reason = `HTTP ${res.status}`;
        markPushFailed(record, svc.name, reason);
        warnPushFailed(svc, payload.phase, reason);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      markPushFailed(record, svc.name, reason);
      warnPushFailed(svc, payload.phase, reason);
    }
  }));
}

// Wave 6.56.D3 — detect an undici-issued AbortError so the fan-out retry
// path can pick it up. The thrown value is a DOMException whose `.name` is
// `"AbortError"` and `.message` is `"This operation was aborted"`.
function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  return typeof e.message === "string" && e.message === "This operation was aborted";
}

// Apply the new target to the singleton — the synchronous core of what the
// pre-6.43 `setActiveTarget` did. Split out so the async switch coordinator
// can run prepare/drain BEFORE committing, while a first-time set (or any
// path with no subscribers) can still complete inside one event-loop tick
// so existing call sites that don't `await` see the same observable
// ordering as before.
function commitActiveTargetSync(t: ActiveTarget, creds?: ActiveTargetCreds): void {
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
  activeTargetVersion += 1;
  // Wave 6.21 (M6) — detach every pool member from its current client and
  // schedule a deferred `disconnect()` so any command issued in the last few
  // hundred ms gets a chance to complete. The pool slot itself is reset
  // immediately so the very next acquisition routes to a freshly built client
  // against the new target — no traffic lands on the draining socket.
  detachPoolMembersForSwap();
  // Wave 6.26 — a profile switch tears down every pool slot's socket; the
  // last cached PING verdict refers to those now-gone clients and would let
  // /readyz lie green during the brief window before the new sockets finish
  // their TLS handshake / cluster-topology discovery on the new target.
  runtimeReadinessCache = null;
  runtimeReadinessInFlight = null;
  for (const fn of listeners) {
    try { fn(override); } catch { /* listener errors must not break the setter */ }
  }
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
//
// Wave 6.43.B.1 — `setActiveTarget` is async: it generates a `switch_id`,
// HTTP-POSTs `/admin/active-target/prepare` to every KNOWN_SERVICES endpoint
// in parallel, waits for each service to ACK `drained` (via the push
// response OR `POST /internal/redis/active-target/ack`) or for
// `SWITCH_DRAIN_TIMEOUT_MS` to elapse — whichever first — commits the
// identity swap, then HTTP-POSTs `/admin/active-target/commit` to every
// service. The first-ever set (no prior `override`) skips the prepare phase
// entirely — services are typically not yet running during boot. In
// NODE_ENV=test without an explicit `__setSwitchPusherForTests` seam, the
// HTTP push is short-circuited so the existing test fleet doesn't open
// real sockets and the commit fires synchronously, preserving the
// observable ordering of the pre-6.43 sync setter for those tests.
export async function setActiveTarget(
  t: ActiveTarget,
  creds?: ActiveTargetCreds,
): Promise<void> {
  const isFirstSwitch = override === undefined;
  const knownServices = getKnownServices();
  const switchId = randomUUID();
  const nextVersion = activeTargetVersion + 1;
  const record: SwitchRecord = {
    switch_id: switchId,
    startedAt: Date.now(),
    next: { label: t.label, version: nextVersion },
    phase: "prepare",
    perService: new Map(
      knownServices.map((s) => [s.name, { name: s.name, phase: "pending" as ServiceSwitchPhase }]),
    ),
  };
  rotateSwitchHistory(record);

  // Fast path: first-ever set (no OLD target, services typically not up yet),
  // tests without a pusher seam (real fetch would 5xx forever against bogus
  // ports), or an empty KNOWN_SERVICES list (nothing to notify).
  const useFastPath =
    isFirstSwitch ||
    (switchPusherForTests === null && process.env.NODE_ENV === "test") ||
    knownServices.length === 0;

  if (useFastPath) {
    commitActiveTargetSync(t, creds);
    record.phase = "committed";
    return;
  }

  record.phase = "draining";
  // Kick off the parallel prepare push; each successful response auto-ACKs
  // the service as `drained` via `applyPushAck`, each failure marks
  // `push_failed`. Both are terminal so the drain wait resolves as soon as
  // every service has settled OR `SWITCH_DRAIN_TIMEOUT_MS` elapses.
  // Fire-and-forget: we intentionally do NOT await preparePush. Each push
  // call settles within `SWITCH_PUSH_TIMEOUT_MS` (AbortController-bounded
  // for real fetch) and updates per-service state via applyPushAck /
  // markPushFailed; both helpers guard against overwriting terminal phases
  // so a push that resolves AFTER drain_timeout cannot corrupt the record.
  void fanOutSwitchPush(
    knownServices,
    "drained",
    {
      switch_id: switchId,
      phase: "prepare",
      target: { label: t.label, version: nextVersion },
      t: Date.now(),
    },
    record,
  );
  await waitForDrain(record, getSwitchDrainTimeoutMs());

  // Anything still in `pending` after the wait did not drain in time.
  for (const sp of record.perService.values()) {
    if (sp.phase === "pending") sp.phase = "drain_timeout";
  }
  commitActiveTargetSync(t, creds);
  record.phase = "committed";

  await fanOutSwitchPush(
    knownServices,
    "committed",
    {
      switch_id: switchId,
      phase: "commit",
      target: { label: t.label, version: activeTargetVersion },
      t: Date.now(),
    },
    record,
  );
}

// Wave 6.21 (M6) — runs on `setActiveTarget` profile-switch / creds rotation.
// Walks both pools; for each member that holds an in-flight client, hands
// the client off to the drain set with a `POOL_DRAIN_GRACE_MS` timer before
// calling `disconnect()`. The pool member's `client` / `wrapper` / `key`
// slots are blanked synchronously so subsequent acquisitions rebuild against
// the new target. The next `acquireFromPool(...)` will bump `generation` so
// 6.22's logger can distinguish the pre-swap client from the post-swap
// rebuild on the same slot id.
function detachPoolMembersForSwap(): void {
  const graceMs = getPoolDrainGraceMs();
  for (const pool of allPools) {
    for (const m of pool.members) {
      const old = m.client;
      m.client = null;
      m.wrapper = null;
      m.key = "";
      // Wave 6.22 — a target swap implies a fresh Redis identity; carrying
      // the prior socket's circuit state across the swap would mark the
      // first command against the new target as "still recovering" even
      // when the new target is healthy. Reset to closed/0 so the next
      // acquisition starts clean.
      m.circuitState = "closed";
      m.consecutiveFailures = 0;
      m.openedAt = 0;
      // Wave 6.30.B4 — a target swap means any half-open recovery for the
      // previous Redis identity is moot; cancel the probe and reset its
      // backoff so the next failure on the new target starts fresh at 10s.
      cancelScheduledProbe(m);
      m.currentBackoffMs = 0;
      if (old) {
        drainingClients.add(old);
        const timer = setTimeout(() => {
          drainingClients.delete(old);
          try { old.disconnect(); } catch { /* ignore */ }
        }, graceMs);
        // Avoid keeping the event loop alive purely to drain an idle client.
        if (typeof timer.unref === "function") timer.unref();
      }
    }
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
  activeTargetVersion = 1;
  // Wave 6.43.B.1 — clear in-flight switch coordination state so a test
  // teardown can't leak per-service ACK history or a pending drain notifier
  // into the next case. Note: the `__setSwitchPusherForTests` seam is NOT
  // touched here — tests install / uninstall it explicitly.
  if (currentSwitch?.drainNotify) currentSwitch.drainNotify = undefined;
  currentSwitch = null;
  priorSwitchIds.clear();
  if (cachedBootClient) {
    try { cachedBootClient.disconnect(); } catch { /* ignore */ }
  }
  cachedBootClient = null;
  cachedBootClientKey = "";
  // Wave 6.26 — discard any cached runtime-pool readiness verdict so the
  // next /readyz probe issues fresh PINGs against the rebuilt pools.
  runtimeReadinessCache = null;
  runtimeReadinessInFlight = null;
  // Wave 6.21 — tear down every pool member; subsequent acquisitions rebuild
  // lazily against the (now-default) target. No drain grace here: this path
  // is test-teardown / process shutdown, where prompt cleanup matters more
  // than letting in-flight commands finish.
  for (const pool of allPools) {
    for (const m of pool.members) {
      if (m.client) {
        try { m.client.disconnect(); } catch { /* ignore */ }
      }
      m.client = null;
      m.wrapper = null;
      m.key = "";
      // Wave 6.22 — full teardown clears circuit state alongside the socket;
      // pool.members is truncated below anyway, but keeping the reset
      // explicit guards against future code paths that hold a reference
      // to the old member object.
      m.circuitState = "closed";
      m.consecutiveFailures = 0;
      m.openedAt = 0;
      // Wave 6.30.B4 — make sure no half-open probe timer survives a test
      // teardown / process reset (would otherwise fire against a torn-down
      // pool member and trip the test runner's open-handle detector).
      cancelScheduledProbe(m);
      m.currentBackoffMs = 0;
    }
    pool.members.length = 0;
    pool.rrIndex = 0;
  }
  // Disconnect any clients still mid-drain so test runners do not see
  // zombie sockets / setTimeout handles between cases.
  for (const c of drainingClients) {
    try { c.disconnect(); } catch { /* ignore */ }
  }
  drainingClients.clear();
}

export function onActiveTargetChange(fn: ActiveTargetListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Internal factory shared by the boot and runtime client accessors. The
// per-call differences are `commandTimeout` (boot 10s / pool 35s) AND the
// Wave 6.23 `fastFail` opt-in — everything else (host, port, db, tls, creds,
// keepAlive, connectTimeout) is identical so a profile switch rebuilds every
// cache in lockstep via `targetKey(...)`.
//
// Wave 6.23 — `fastFail` MUST default to false. The boot path (see Wave 6.18c)
// relies on ioredis's default retry budget (3) + default offline queue to
// survive transient hiccups during `bootstrapFrtb()` long enough for
// `withBootTimeout` to make the binding decision. Only the runtime pool
// members opt in to `fastFail: true`.
interface BuildClientOpts {
  commandTimeout: number;
  // When true: `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`. Pool
  // members only; the boot singleton MUST keep ioredis defaults so a flaky
  // first connect doesn't permanently fail bootstrap.
  fastFail?: boolean;
}

function buildClient(
  t: ActiveTarget,
  c: ActiveTargetCreds,
  opts: BuildClientOpts,
): Redis {
  const { commandTimeout, fastFail = false } = opts;
  return new Redis({
    host: t.host,
    port: t.port,
    db: t.db,
    tls: t.tls ? {} : undefined,
    ...(c.username ? { username: c.username } : {}),
    ...(c.password ? { password: c.password } : {}),
    lazyConnect: true,
    // Wave 6.23 — pool members opt in to fast-fail so a degraded socket
    // surfaces the error on the very next command instead of silently
    // re-queueing commands behind the scenes (ioredis default: 20 retries).
    // The boot singleton DOES NOT set these: bootstrap needs ioredis's
    // default retry + offline-queue behaviour so a transient hiccup at
    // process start doesn't fail-stop `bootstrapFrtb` before
    // `withBootTimeout` gets a chance to gate the binding decision
    // (Wave 6.18c invariant).
    ...(fastFail
      ? {
          maxRetriesPerRequest: 1,
          // ioredis's offline queue (default on) buffers commands while the
          // socket is down/reconnecting and dispatches the whole backlog on
          // recovery — amplifying the spike. Off => commands reject
          // immediately => routes surface a fast 5xx and shed load.
          enableOfflineQueue: false,
        }
      : {}),
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
  // Wave 6.23 — boot client must NOT enable fast-fail. Bootstrap relies on
  // ioredis's default retry budget + offline queue to ride out transient
  // hiccups long enough for `withBootTimeout` to make the binding decision.
  cachedBootClient = buildClient(t, c, { commandTimeout: BOOT_COMMAND_TIMEOUT_MS });
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
// Production evidence on a large clustered target (calc-discovery-failed × 24,
// all at exactly 10s) showed routes being aborted by the boot-protection ioredis 10s timeout
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
// Wave 6.56.D4 — async return because `acquireFromPool` now awaits the
// underlying socket reaching `ready` before publishing the wrapper. The
// `getRedis` accessor wired in server.ts / index.ts and every route
// handler that consumes it propagates the await.
export async function getActiveRedisRuntimeClient(category: RuntimeCategory = "heavy-calc"): Promise<Redis | null> {
  const normalized = normalizeCategory(category);
  const pool = poolForNormalized(normalized);
  return acquireFromPool(pool, normalized);
}

// Wave 6.40.X — read the effective pool size for `category` with a per-category
// env-var chain. heavy-calc falls back to the legacy `RUNTIME_REDIS_POOL_SIZE_
// HEAVY` so an operator who already tuned the unified heavy pool keeps the same
// dial. heavy-ingest has no legacy fallback (new pool). Exported so the
// backpressure plugin can derive its per-category in-flight budget from the
// same number the pool itself sizes against.
export function getRuntimePoolSize(category: RuntimeCategory): number {
  const normalized = normalizeCategory(category);
  if (normalized === "light") return getPoolSize("RUNTIME_REDIS_POOL_SIZE_LIGHT");
  if (normalized === "heavy-ingest") return getPoolSize("RUNTIME_REDIS_POOL_SIZE_HEAVY_INGEST");
  const raw = process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return getPoolSize("RUNTIME_REDIS_POOL_SIZE_HEAVY");
}

// Resize the pool's slot array to `size`. Grows by appending empty slots
// (lazy-built on first acquisition); shrinks by disconnecting and dropping
// surplus members so a runtime env tweak that lowers the pool size releases
// the extra sockets next time around. Wave 6.21 (M1) — each new slot is
// stamped with a stable `${category}:${index}` id; the id is `readonly` on
// PoolMember so it survives every rebuild on the slot.
function ensurePoolSized(pool: Pool, size: number): void {
  if (pool.members.length === size) return;
  if (pool.members.length < size) {
    while (pool.members.length < size) {
      const index = pool.members.length;
      pool.members.push({
        id: `${pool.category}:${index}`,
        client: null,
        wrapper: null,
        key: "",
        createdAt: 0,
        generation: 0,
        consecutiveFailures: 0,
        circuitState: "closed",
        openedAt: 0,
        currentBackoffMs: 0,
        probeTimer: null,
      });
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

// Round-robin acquisition. Picks the next non-open slot, rebuilds if its
// `key` disagrees with the current `targetKey(...)` (setActiveTarget
// rotation) OR if the slot was previously marked stale by the recycle hook.
// Wave 6.22 — open members are skipped; when every member is open, the
// oldest one is transitioned to `half-open` and rebuilt to probe recovery.
// Returns the recycle-aware Proxy wrapper, NOT the raw ioredis client, so
// callers automatically participate in the per-member self-heal flow.
// Wave 6.56.D4 — `acquireFromPool` is async because the freshly built
// client (lazyConnect:true + enableOfflineQueue:false) must reach `ready`
// before its wrapper is published, otherwise the very first command races
// the TCP/TLS handshake and throws "Stream isn't writeable". The await
// uses `awaitMemberReady` — the same readiness bridge `/readyz` relies on.
async function acquireFromPool(pool: Pool, category: NormalizedCategory): Promise<Redis | null> {
  const t = getActiveTarget();
  const c = overrideCreds;
  const key = targetKey(t);
  ensurePoolSized(pool, getRuntimePoolSize(category));
  if (pool.members.length === 0) return null;

  // Wave 6.22 — find the next member whose circuit is NOT open. Walk at
  // most pool.length slots from the current rrIndex; if every slot is open
  // we drop into the half-open promotion path below.
  const total = pool.members.length;
  let chosenIdx = -1;
  for (let step = 0; step < total; step++) {
    const i = (pool.rrIndex + step) % total;
    if (pool.members[i]!.circuitState !== "open") {
      chosenIdx = i;
      break;
    }
  }
  if (chosenIdx === -1) {
    chosenIdx = promoteOldestToHalfOpen(pool);
  }
  // Advance rrIndex past the chosen slot so the next acquisition starts at
  // the slot after this one, preserving the existing round-robin contract.
  pool.rrIndex = (chosenIdx + 1) % total;
  const member = pool.members[chosenIdx]!;

  if (member.client && member.wrapper && member.key === key) {
    return member.wrapper;
  }
  if (member.client) {
    try { member.client.disconnect(); } catch { /* ignore */ }
  }
  // Wave 6.21 (M1) — bump generation BEFORE constructing the new client so
  // any 6.22 structured log line agrees on which build attempt this is.
  member.generation += 1;
  member.createdAt = Date.now();
  // Wave 6.23 — pool members opt in to fast-fail so a degraded socket
  // surfaces the error immediately instead of holding the request open.
  const runtimeOpts: BuildClientOpts = {
    commandTimeout: getRuntimeCommandTimeoutMs(),
    fastFail: true,
  };
  const built = runtimeClientFactoryForTests
    ? runtimeClientFactoryForTests(t, c, runtimeOpts)
    : buildClient(t, c, runtimeOpts);
  attachErrorRecycle(built, member);
  // Wave 6.56.D4 — wait for the socket to reach `ready` BEFORE publishing
  // the wrapper. Bounded by the runtime command-timeout (~10s default) so a
  // stuck handshake fails fast and the caller's request errors cleanly
  // instead of holding the slot indefinitely. On failure, tear down the
  // half-built socket and surface the error — the next acquisition rebuilds.
  try {
    await awaitMemberReady(built, getRuntimeCommandTimeoutMs());
  } catch (err) {
    try { built.disconnect(); } catch { /* ignore */ }
    member.client = null;
    member.wrapper = null;
    member.key = "";
    throw err;
  }
  member.client = built;
  member.wrapper = wrapWithRecycle(built, member);
  member.key = key;
  // Wave 6.22 — `consecutiveFailures` is intentionally NOT reset here. A
  // sub-threshold failure recycles the socket (see noteFailure) and the
  // very next acquisition rebuilds; if the rebuild reset the counter,
  // three consecutive failures spread across three socket rebuilds would
  // never trip the circuit. Only `noteSuccess` clears the counter.
  emitPoolEvent("pool-member-built", member, pool, { generation: member.generation });
  return member.wrapper;
}

// Wave 6.22 — when every member is open, promote the one whose circuit
// opened the longest ago (and at least `CIRCUIT_BACKOFF_MS` ago when any
// member qualifies) to `half-open`. Returns the chosen index. The chosen
// member's `client` slot is blanked so the acquisition path rebuilds it.
function promoteOldestToHalfOpen(pool: Pool): number {
  const backoff = getCircuitBackoffMs();
  const now = Date.now();
  let oldestIdx = 0;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pool.members.length; i++) {
    const m = pool.members[i]!;
    if (m.openedAt < oldestAt) {
      oldestAt = m.openedAt;
      oldestIdx = i;
    }
  }
  const m = pool.members[oldestIdx]!;
  if (now - m.openedAt < backoff) {
    // Backoff window not yet elapsed for any member — promote the oldest
    // anyway (the alternative is rejecting acquisition entirely, which
    // makes the pool useless during an outage). The probe still
    // fast-fails via Wave 6.23's `maxRetriesPerRequest: 1` if Redis is
    // genuinely down, so this just gates how often we burn a rebuild.
  }
  transitionCircuit(m, "half-open", pool, "all-open-promotion");
  if (m.client) {
    try { m.client.disconnect(); } catch { /* ignore */ }
  }
  m.client = null;
  m.wrapper = null;
  m.key = "";
  return oldestIdx;
}

// Inspect an error and decide whether the member that surfaced it should be
// counted toward the circuit-breaker threshold. Matches the connection-level
// codes that almost always indicate a poisoned socket, plus the ioredis
// `commandTimeout`-induced "Command timed out" message that signals the
// in-Redis budget was exhausted on this socket.
function shouldRecycle(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "ETIMEDOUT" || e.code === "ECONNRESET" || e.code === "EPIPE") return true;
  const msg = typeof e.message === "string" ? e.message : String(err);
  if (msg.includes("Command timed out")) return true;
  // Wave 6.56.D4 — defence-in-depth: if a not-yet-ready ioredis client ever
  // reaches a route (`enableOfflineQueue:false` + `lazyConnect:true` race),
  // recycle the slot so the next acquisition rebuilds and awaits readiness
  // instead of holding the same broken wrapper forever.
  return msg.includes("Stream isn't writeable");
}

// Tear down the underlying socket for `member` so the next acquisition
// rebuilds. Idempotent across the two recycle entry points (the `on('error')`
// socket hook AND the Proxy-wrapper rejection hook) — both compare
// `member.client === client` before tearing down so a slot that's already
// been rotated to a fresh client is not accidentally re-cleared.
function recyclePoolMember(member: PoolMember, pool: Pool, client: Redis): void {
  if (member.client !== client) return;
  member.client = null;
  member.wrapper = null;
  member.key = "";
  try { client.disconnect(); } catch { /* ignore */ }
  emitPoolEvent("pool-member-recycled", member, pool, { generation: member.generation });
}

// Wave 6.22 — record a failure against `member`. Increments the consecutive
// counter and, when it reaches the threshold, transitions the circuit to
// `open` and tears the socket down. A `half-open` member that fails is
// immediately re-opened regardless of the counter (a probe needs to prove
// recovery; one stumble is enough to send it back to penalty).
function noteFailure(member: PoolMember, pool: Pool, client: Redis, err: unknown): void {
  member.consecutiveFailures += 1;
  if (member.circuitState === "half-open") {
    transitionCircuit(member, "open", pool, "half-open-failed", err);
    recyclePoolMember(member, pool, client);
    return;
  }
  // Wave 6.30.B4 — Option C: fatal-error-pattern fast-trip. A single
  // "Command timed out" / "Stream isn't writeable" / per-command timeout
  // is unambiguous enough to flip the breaker immediately instead of
  // burning the full `failure-threshold × command-timeout` clock budget
  // the 2026-06-17 incident demonstrated (~105s for one stuck slot).
  if (isFatalErrorPattern(err)) {
    transitionCircuit(member, "open", pool, "fatal-error-fast-trip", err);
    recyclePoolMember(member, pool, client);
    return;
  }
  if (member.consecutiveFailures >= getFailureThreshold()) {
    transitionCircuit(member, "open", pool, "failure-threshold", err);
    recyclePoolMember(member, pool, client);
    return;
  }
  // Below threshold but still a poisoned-socket error code — recycle the
  // socket so the next acquisition rebuilds, while leaving the circuit
  // `closed` so traffic continues to land on this slot once rebuilt.
  recyclePoolMember(member, pool, client);
}

// Wave 6.22 — record a successful command. Closes a half-open circuit and
// resets the consecutive-failure counter so the next failure starts a fresh
// count toward the threshold.
function noteSuccess(member: PoolMember, pool: Pool): void {
  if (member.circuitState === "half-open") {
    transitionCircuit(member, "closed", pool, "half-open-recovered");
  }
  member.consecutiveFailures = 0;
}

function transitionCircuit(
  member: PoolMember,
  next: CircuitState,
  pool: Pool,
  cause: string,
  err?: unknown,
): void {
  const prev = member.circuitState;
  if (prev === next) return;
  member.circuitState = next;
  if (next === "open") {
    member.openedAt = Date.now();
    // Wave 6.30.B4 — schedule a half-open probe. First open uses the
    // initial backoff; a half-open that flips straight back to open
    // doubles the prior delay (capped) so a persistently-down member
    // doesn't burn rebuilds at full speed.
    if (prev === "half-open" && member.currentBackoffMs > 0) {
      const cap = getHalfOpenBackoffCapMs();
      member.currentBackoffMs = Math.min(member.currentBackoffMs * 2, cap);
    } else {
      member.currentBackoffMs = getHalfOpenInitialBackoffMs();
    }
    scheduleHalfOpenProbe(member, pool);
  } else if (next === "closed") {
    member.openedAt = 0;
    // Wave 6.30.B4 — recovery: drop any pending probe timer and reset
    // backoff so the next failure starts fresh at the initial delay.
    cancelScheduledProbe(member);
    member.currentBackoffMs = 0;
  } else if (next === "half-open") {
    // Wave 6.30.B4 — the probe is firing now (or a forced promotion via
    // `promoteOldestToHalfOpen`); cancel any still-pending timer so it
    // can't double-fire mid-probe.
    cancelScheduledProbe(member);
  }
  emitPoolEvent("pool-circuit-transition", member, pool, {
    from: prev,
    to: next,
    cause,
    err: err === undefined ? undefined : formatErr(err),
  });
}

// Structured pool event emitted on every state transition. Production wires
// this through Fastify's logger by default; tests can override via
// `__setPoolEventSinkForTests` to capture the stream without a Fastify
// instance. Field set is deliberately narrow — no passwords, no URLs.
type PoolEvent =
  | "pool-circuit-transition"
  | "pool-member-recycled"
  | "pool-member-built"
  | "pool-command-fail-fast";

export interface PoolEventPayload {
  evt: PoolEvent;
  // Wave 6.40.X — emitted as one of the three concrete categories (the
  // `"heavy"` alias is normalised to `"heavy-calc"` before any pool event
  // fires) so log filters can match on stable values.
  category: NormalizedCategory;
  member_id: string;
  consecutive_failures: number;
  circuit_state: CircuitState;
  generation: number;
  from?: CircuitState;
  to?: CircuitState;
  cause?: string;
  err?: string;
}

type PoolEventSink = (payload: PoolEventPayload) => void;

const defaultPoolEventSink: PoolEventSink = (p) => {
  // Single structured line, kept off stdout when running under vitest to
  // avoid flooding test output. JSON.stringify so a log scraper can grep
  // for `"evt":"pool-circuit-transition"` directly.
  if (process.env.NODE_ENV === "test") return;
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(p));
  } catch { /* ignore */ }
};

let poolEventSink: PoolEventSink = defaultPoolEventSink;

function emitPoolEvent(
  evt: PoolEvent,
  member: PoolMember,
  pool: Pool,
  extras: Partial<Pick<PoolEventPayload, "from" | "to" | "cause" | "err" | "generation">> = {},
): void {
  try {
    poolEventSink({
      evt,
      category: pool.category,
      member_id: member.id,
      consecutive_failures: member.consecutiveFailures,
      circuit_state: member.circuitState,
      generation: extras.generation ?? member.generation,
      ...(extras.from ? { from: extras.from } : {}),
      ...(extras.to ? { to: extras.to } : {}),
      ...(extras.cause ? { cause: extras.cause } : {}),
      ...(extras.err ? { err: extras.err } : {}),
    });
  } catch { /* sink must never break the pool path */ }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// Subscribe to ioredis's connection-level `error` channel so a socket that
// transitions to ETIMEDOUT/ECONNRESET/EPIPE outside of an in-flight command
// (mid-reconnect bursts, idle keepalive failures) still trips the failure
// path. Wave 6.23's `enableOfflineQueue:false` keeps these errors loud
// instead of silently queued, so we MUST install a listener — without one,
// node would treat the emitted error as unhandled.
function attachErrorRecycle(client: Redis, member: PoolMember): void {
  const pool = poolForCategory(member);
  client.on("error", (err: unknown) => {
    if (shouldRecycle(err)) noteFailure(member, pool, client, err);
  });
}

// Resolve the `Pool` a member belongs to from its stable id prefix
// (`${category}:${index}`). Cheap enough — every member id is parsed once
// per error event, and pools never move members between categories.
function poolForCategory(member: PoolMember): Pool {
  if (member.id.startsWith("light:")) return lightPool;
  if (member.id.startsWith("heavy-ingest:")) return heavyIngestPool;
  return heavyCalcPool;
}

// Wrap the ioredis client in a Proxy that mirrors every property access but
// intercepts the promise returned by each method call. Successful commands
// reset the per-member failure counter; rejected commands feed the circuit
// breaker. The rejection still reaches the caller unchanged (we re-throw
// via `throw err`).
function wrapWithRecycle(client: Redis, member: PoolMember): Redis {
  const pool = poolForCategory(member);
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function wrapped(...args: unknown[]): unknown {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (out && typeof (out as Promise<unknown>).then === "function") {
          const method = typeof prop === "symbol" ? prop.toString() : String(prop);
          return raceWithFailFast(out as Promise<unknown>, method, member, pool, client);
        }
        return out;
      };
    },
  }) as Redis;
}

// Wave 6.30.B4 — Option A: per-command timeout wrapped around each pool
// dispatch. The category-specific budget (5s heavy / 1.5s light by default)
// is enforced via `Promise.race`; on timeout we synthesise a
// `pool-command-fail-fast` error, emit the structured event, and feed the
// circuit breaker — the synthesised message matches `FATAL_ERROR_PATTERN`
// so `noteFailure` fast-trips on consecutive_failures=1 instead of waiting
// for the threshold. The caller sees a clean rejection that names the
// pool member, the category, and the method that wedged.
function raceWithFailFast(
  p: Promise<unknown>,
  method: string,
  member: PoolMember,
  pool: Pool,
  client: Redis,
): Promise<unknown> {
  const timeoutMs = getCommandTimeoutMs(pool.category);
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(
        `pool-command-fail-fast: Command timed out after ${timeoutMs}ms ` +
        `(category=${pool.category} member=${member.id} method=${method})`,
      );
      emitPoolEvent("pool-command-fail-fast", member, pool, {
        cause: "per-command-timeout",
        err: err.message,
      });
      noteFailure(member, pool, client, err);
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        noteSuccess(member, pool);
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (shouldRecycle(err)) noteFailure(member, pool, client, err);
        reject(err);
      },
    );
  });
}

// Wave 6.30.B4 — schedule the next half-open probe for `member`. Caller has
// already populated `currentBackoffMs` with the desired delay (initial on
// the first open, doubled on a half-open→open). Cancels any prior timer so
// a forced promotion / target swap doesn't leave a zombie probe waiting.
function scheduleHalfOpenProbe(member: PoolMember, pool: Pool): void {
  cancelScheduledProbe(member);
  const delay = member.currentBackoffMs;
  if (delay <= 0) return;
  const timer = setTimeout(() => {
    member.probeTimer = null;
    runHalfOpenProbe(member, pool).catch(() => { /* reschedule handled inline */ });
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
  member.probeTimer = timer;
}

function cancelScheduledProbe(member: PoolMember): void {
  if (member.probeTimer) {
    clearTimeout(member.probeTimer);
    member.probeTimer = null;
  }
}

// Wave 6.30.B4 — half-open recovery probe. Transitions the member to
// `half-open`, blanks the slot, builds a fresh client, and issues a single
// PING through the recycle wrapper so the success/failure outcome feeds
// the same circuit-breaker plumbing as a normal command. The wrapper's
// `noteSuccess` closes the circuit on PONG; `noteFailure` flips it back to
// open and `transitionCircuit` doubles the backoff for the next attempt.
async function runHalfOpenProbe(member: PoolMember, pool: Pool): Promise<void> {
  if (member.circuitState !== "open") return;
  transitionCircuit(member, "half-open", pool, "scheduled-probe");
  if (member.client) {
    try { member.client.disconnect(); } catch { /* ignore */ }
  }
  member.client = null;
  member.wrapper = null;
  member.key = "";
  const t = getActiveTarget();
  const c = overrideCreds;
  const runtimeOpts: BuildClientOpts = {
    commandTimeout: getRuntimeCommandTimeoutMs(),
    fastFail: true,
  };
  const built = runtimeClientFactoryForTests
    ? runtimeClientFactoryForTests(t, c, runtimeOpts)
    : buildClient(t, c, runtimeOpts);
  attachErrorRecycle(built, member);
  member.client = built;
  member.wrapper = wrapWithRecycle(built, member);
  member.key = targetKey(t);
  member.generation += 1;
  member.createdAt = Date.now();
  emitPoolEvent("pool-member-built", member, pool, { generation: member.generation });
  try {
    await (member.wrapper as unknown as { ping: () => Promise<unknown> }).ping();
  } catch { /* wrapper has already updated circuit state + scheduled retry */ }
}

// Test seam — override the pool event sink so unit tests can capture the
// structured transition stream without a Fastify logger. Pass `null` to
// restore the production console sink.
export function __setPoolEventSinkForTests(fn: PoolEventSink | null): void {
  poolEventSink = fn ?? defaultPoolEventSink;
}

// Test seam — install a fake client factory so unit tests in
// `runtime-pool.test.ts` can build pool members without opening real TCP
// sockets and assert round-robin / recycle / lockstep-invalidation
// behaviour. Pass `null` to restore the production `buildClient(...)` path.
export function __setRuntimeClientFactoryForTests(
  fn:
    | ((t: ActiveTarget, c: ActiveTargetCreds, opts: BuildClientOpts) => Redis)
    | null,
): void {
  runtimeClientFactoryForTests = fn;
}

// Test seam — exposes a structured view of a pool so unit tests can assert
// pool size, member identity, key liveness, and rrIndex without poking at
// module-internal state. Returns a snapshot; mutation is intentionally
// disabled (slots are spread into a fresh array of value copies).
export function __getRuntimePoolForTests(category: RuntimeCategory): {
  members: {
    id: string;
    client: Redis | null;
    wrapper: Redis | null;
    key: string;
    createdAt: number;
    generation: number;
    consecutiveFailures: number;
    circuitState: CircuitState;
    openedAt: number;
  }[];
  rrIndex: number;
} {
  const pool = poolForNormalized(normalizeCategory(category));
  return {
    members: pool.members.map((m) => ({
      id: m.id,
      client: m.client,
      wrapper: m.wrapper,
      key: m.key,
      createdAt: m.createdAt,
      generation: m.generation,
      consecutiveFailures: m.consecutiveFailures,
      circuitState: m.circuitState,
      openedAt: m.openedAt,
    })),
    rrIndex: pool.rrIndex,
  };
}

// Wave 6.21 (M1) — public accessor returning the stable identity surface for
// a pool slot. Returns `null` when the requested index has not been
// materialised yet (pool not sized to include `index`). Callers (6.22's
// structured logger, future ops dashboards) MUST tolerate the null because
// pools size lazily on first acquisition. The returned object is a snapshot;
// `generation` and `createdAt` may have advanced by the time the caller
// observes them.
export function getPoolMemberInfo(
  category: RuntimeCategory,
  index: number,
): PoolMemberInfo | null {
  const pool = poolForNormalized(normalizeCategory(category));
  const m = pool.members[index];
  if (!m) return null;
  return { id: m.id, createdAt: m.createdAt, generation: m.generation };
}

// Wave 6.26 — probe every runtime-pool member with a cheap `PING` so /readyz
// can refuse to flip green until the pool sockets are actually writable
// (handshake complete, cluster topology discovered). `acquireFromPool`
// rotates `rrIndex` per call, so issuing `poolSize` acquisitions in
// sequence hits each slot once. The verdict is cached for
// `RUNTIME_READINESS_CACHE_MS` and concurrent calls share a single
// in-flight Promise so /readyz polling cannot stampede.
//
// Wave 6.36.A — the original Wave 6.26 implementation walked the members
// serially and relied on `await c.ping()` to trigger the lazy connect on
// each socket in turn. With Wave 6.23's `enableOfflineQueue:false` +
// `maxRetriesPerRequest:1`, that first PING fast-fails with "Stream isn't
// writeable" if the socket is in `connecting`/`reconnecting` rather than
// `wait`, and the 250ms failure cache turned each retry into a ≥250ms
// wait — pushing /readyz warm-restart latency to ~2.8s (≈11 cycles × 250ms)
// against a localhost Redis. Two fixes restore the <1s contract:
//   1. `awaitMemberReady(...)` waits for the per-member socket to reach
//      `ready` (via `connect()` from `wait`, or a `'ready'` event listener
//      from any other transitional state) before firing PING, so the probe
//      proves readiness instead of racing the handshake.
//   2. Members are pinged via `Promise.all` so the 8 sockets establish
//      concurrently rather than 8×RTT serially.
export async function probeRuntimeRedisReadiness(): Promise<RuntimeReadinessVerdict> {
  const now = Date.now();
  if (runtimeReadinessCache && now - runtimeReadinessCache.ts < RUNTIME_READINESS_CACHE_MS) {
    return runtimeReadinessCache.err !== undefined
      ? { ok: runtimeReadinessCache.ok, err: runtimeReadinessCache.err }
      : { ok: runtimeReadinessCache.ok };
  }
  if (runtimeReadinessInFlight) return runtimeReadinessInFlight;
  runtimeReadinessInFlight = (async () => {
    try {
      // Wave 6.40.X — probe all three categories. heavy-calc / heavy-ingest /
      // light each have their own pool; readiness must verify EVERY pool's
      // members so a stuck ingest pool can fail /readyz independently of calc.
      // Wave 6.56.D4 — getActiveRedisRuntimeClient is async (it awaits member
      // readiness internally). Run every acquisition in parallel so the 8+8+4
      // sockets handshake concurrently rather than ≈20×RTT serially.
      const acquisitions: Array<Promise<Redis | null>> = [];
      for (const category of ["heavy-calc", "heavy-ingest", "light"] as const) {
        const size = getRuntimePoolSize(category);
        for (let i = 0; i < size; i++) {
          acquisitions.push(getActiveRedisRuntimeClient(category));
        }
      }
      const all = await Promise.all(acquisitions);
      for (const c of all) {
        if (!c) throw new Error("no active runtime client");
      }
      await Promise.all((all as Redis[]).map(async (c) => {
        await awaitMemberReady(c);
        await c.ping();
      }));
      runtimeReadinessCache = { ts: Date.now(), ok: true };
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      runtimeReadinessCache = { ts: Date.now(), ok: false, err: msg };
      return { ok: false, err: msg };
    } finally {
      runtimeReadinessInFlight = null;
    }
  })();
  return runtimeReadinessInFlight;
}

// Wave 6.36.A — bridge a pool member's ioredis socket from its initial
// `wait` (lazyConnect) / transitional `connecting` / `reconnecting` state
// to `ready` before issuing the probe PING. Tolerates the "already
// connecting/connected" error from a racing `connect()` call. Clients
// without a recognised `status` field (e.g. test fakes, the boot-protection
// client) fall through to PING directly — preserving the pre-6.36 contract
// for non-ioredis surfaces.
//
// Wave 6.56.D4 — optional `timeoutMs` bounds the wait so a stuck handshake
// (TLS, cluster topology, DNS) cannot pin `acquireFromPool` indefinitely.
// `/readyz` continues to call without a timeout (its outer probe budget
// stays the bound).
async function awaitMemberReady(c: Redis, timeoutMs?: number): Promise<void> {
  const e = c as unknown as {
    status?: string;
    connect?: () => Promise<unknown>;
    once?: (event: string, cb: (...args: unknown[]) => void) => void;
    off?: (event: string, cb: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  if (typeof e.status !== "string") return;
  if (e.status === "ready") return;
  if (e.status === "wait" && typeof e.connect === "function") {
    try { await withTimeout(e.connect(), timeoutMs, "awaitMemberReady.connect"); return; }
    catch (err) {
      if (!/already connect(ing|ed)/i.test(String(err))) throw err;
    }
  }
  if (e.status === "ready") return;
  if (typeof e.once !== "function") return;
  await withTimeout(new Promise<void>((resolve, reject) => {
    let done = false;
    const cleanup = (): void => {
      const off = e.off ?? e.removeListener;
      off?.call(e, "ready", onReady);
      off?.call(e, "error", onError);
    };
    const onReady = (): void => { if (done) return; done = true; cleanup(); resolve(); };
    const onError = (err: unknown): void => { if (done) return; done = true; cleanup(); reject(err instanceof Error ? err : new Error(String(err))); };
    e.once!("ready", onReady);
    e.once!("error", onError);
  }), timeoutMs, "awaitMemberReady.ready-event");
}

// Wave 6.56.D4 — bound `awaitMemberReady`'s underlying promises by an
// optional deadline so a stuck handshake fails fast and `acquireFromPool`'s
// caller sees a clean rejection. Passing `undefined`/<=0 keeps the
// pre-6.56 unbounded behaviour for `/readyz`'s probe path.
async function withTimeout<T>(p: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Test seam — drop the cached readiness verdict so the next probe runs
// fresh PINGs. Used by /readyz unit tests that flip mocked outcomes
// between cases.
export function __resetRuntimeReadinessCacheForTests(): void {
  runtimeReadinessCache = null;
  runtimeReadinessInFlight = null;
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
