// Wave 7.0.6.17 — bulk-loader runtime state holder + target-swap routine.
//
// Bulk-loader resolves a single Redis target at boot and opens a 32-conn
// pool against it; pre-7.0.6.17, that pool was immutable for the life of
// the process so an operator switching the api's active target from the
// local cluster to Redis Cloud silently left bulk-loader writing to the
// OLD target. This module introduces a mutable runtime holder that
// `server.ts` reads through, plus a `swapTarget` routine the active-target
// watcher invokes when the api's `/internal/redis/active-target/full`
// version bumps. The routine quiesces in-flight writes, tears down the
// pool / dispatcher / checkpointer, builds replacements against the new
// target, and atomically swaps the runtime pointers. On any failure
// mid-swap, accepting stays false so subsequent /load/rows requests fail
// loud (503) rather than silently re-binding to the old target.
//
// Concurrency: a swap-in-progress mutex makes concurrent watcher ticks
// no-op. `accepting` is flipped synchronously at the start of swapTarget
// so a /load/rows arriving DURING the swap sees the stale-or-draining
// state and gets a 503 immediately.

import type { ActiveTargetFull } from "@frtb/redis-client";
import type { WorkerPool } from "./pool.ts";
import type { DispatcherHandle } from "./dispatcher.ts";
import type { Checkpointer, CheckpointRecord } from "./checkpoint.ts";

// Public identity fields only — no password, no URL. Mirrors what
// `/admin/host-info` and the UI banner consume.
export interface BoundTarget {
  host: string;
  port: number;
  label: string;
}

export interface SwapLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface RebuiltRuntime {
  pool: WorkerPool;
  dispatcher: DispatcherHandle;
  checkpointer: Checkpointer | null;
  bootstrapCheckpoints: ReadonlyMap<number, CheckpointRecord>;
}

export interface SwapDeps {
  // Caller-supplied factory that resolves the new target into a fully
  // initialised pool / dispatcher / checkpointer triple. Same code path the
  // boot wiring uses, just parameterised on the resolved target.
  rebuildFromTarget: (target: ActiveTargetFull) => Promise<RebuiltRuntime>;
  // Hard cap for `dispatcher.drain()` during quiesce. Default 30s per spec.
  drainTimeoutMs?: number;
  logger: SwapLogger;
}

export interface BulkLoaderState {
  // Mutable runtime — replaced atomically by swapTarget.
  pool: WorkerPool;
  dispatcher: DispatcherHandle | null;
  checkpointer: Checkpointer | null;
  bootstrapCheckpoints: ReadonlyMap<number, CheckpointRecord>;

  // Identity of the Redis target the current pool is bound to.
  boundTarget: BoundTarget;
  // Monotonic `version` from /internal/redis/active-target/full at the time
  // the current pool was built. Null until the first watcher tick lands.
  boundVersion: number | null;

  // /load/rows + /load/start state.
  accepting: boolean;

  // Stale-target safety net.
  targetStale: boolean;
  targetStaleReason: string | null;
  // Last result of a `/internal/redis/active-target/full` poll; surfaces on
  // /load/status so the UI banner can render the divergence.
  apiActiveTarget: BoundTarget | null;
  apiActiveTargetVersion: number | null;

  // Swap observability.
  targetSwapCount: number;
  lastSwapError: string | null;
  targetWatcher: "enabled" | "disabled";

  // Swap-in-progress mutex. Concurrent ticks no-op.
  swapInFlight: boolean;
}

export interface CreateBulkLoaderStateOpts {
  pool: WorkerPool;
  dispatcher: DispatcherHandle | null;
  checkpointer: Checkpointer | null;
  bootstrapCheckpoints: ReadonlyMap<number, CheckpointRecord>;
  boundTarget: BoundTarget;
  boundVersion?: number | null;
  targetWatcher: "enabled" | "disabled";
  accepting?: boolean;
}

export function createBulkLoaderState(opts: CreateBulkLoaderStateOpts): BulkLoaderState {
  return {
    pool: opts.pool,
    dispatcher: opts.dispatcher,
    checkpointer: opts.checkpointer,
    bootstrapCheckpoints: opts.bootstrapCheckpoints,
    boundTarget: { ...opts.boundTarget },
    boundVersion: opts.boundVersion ?? null,
    accepting: opts.accepting !== false,
    targetStale: false,
    targetStaleReason: null,
    apiActiveTarget: null,
    apiActiveTargetVersion: null,
    targetSwapCount: 0,
    lastSwapError: null,
    targetWatcher: opts.targetWatcher,
    swapInFlight: false,
  };
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

function targetsEqual(a: BoundTarget, b: BoundTarget): boolean {
  return a.host === b.host && a.port === b.port && a.label === b.label;
}

// Run a promise with a hard timeout. Resolves to { timedOut: false } when
// the work completes inside the deadline; otherwise { timedOut: true } so
// the caller can decide whether to abort or proceed. We never reject — a
// drain timeout is a degraded outcome, not an exception.
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    if (typeof timer?.unref === "function") timer.unref();
  });
  try {
    const value = await Promise.race([
      work.then((v) => ({ timedOut: false as const, value: v })),
      timeout,
    ]);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SwapResult {
  ok: boolean;
  reason?: string;
  // True when a concurrent swap was already in flight and this call no-oped.
  skipped?: boolean;
}

// Update the api-side active-target snapshot on the state holder + recompute
// `targetStale`. Stale is only set when the watcher is disabled OR the most
// recent swap failed — when the watcher is enabled and healthy, the next
// tick will swap and clear the stale flag itself. Returns true when the
// stale flag flipped, so callers can log the transition.
export function updateApiActiveTarget(
  state: BulkLoaderState,
  next: BoundTarget | null,
  nextVersion: number | null,
): boolean {
  state.apiActiveTarget = next ? { ...next } : null;
  state.apiActiveTargetVersion = nextVersion;
  const wasStale = state.targetStale;
  if (!next) {
    return false;
  }
  const diverged = !targetsEqual(state.boundTarget, next);
  if (!diverged) {
    // api reverted to match the bound target — clear stale unconditionally.
    if (state.targetStale) {
      state.targetStale = false;
      state.targetStaleReason = null;
    }
    return wasStale !== state.targetStale;
  }
  // Divergent. Auto-set stale when no watcher is wired OR the prior swap
  // failed; otherwise the watcher will swap on its next tick.
  const noWatcher = state.targetWatcher === "disabled";
  const swapFailed = state.lastSwapError !== null;
  if (noWatcher || swapFailed) {
    if (!state.targetStale) {
      state.targetStale = true;
      state.targetStaleReason = formatStaleReason(state.boundTarget, next, noWatcher);
    }
  }
  return wasStale !== state.targetStale;
}

export function formatStaleReason(
  bound: BoundTarget,
  api: BoundTarget,
  noWatcher: boolean,
): string {
  const suffix = noWatcher
    ? "; restart bulk-loader or set INTERNAL_API_TOKEN"
    : "; prior swap failed — restart bulk-loader to recover";
  return `stale target: bulk-loader bound to ${bound.label} (${bound.host}:${bound.port}) but api active-target is ${api.label} (${api.host}:${api.port})${suffix}`;
}

// Core swap routine. Idempotent: a swap into the already-bound target is a
// fast no-op (returns ok=true). Concurrent invocations short-circuit via
// `swapInFlight`. Failures leave `accepting=false` and surface via
// `lastSwapError` so /load/status + /healthz fail loud.
export async function swapTarget(
  state: BulkLoaderState,
  next: ActiveTargetFull,
  deps: SwapDeps,
): Promise<SwapResult> {
  // Concurrency guard. A watcher poll that fires while a swap is mid-flight
  // must not start a second teardown or the old pool gets disconnect()ed
  // twice. The next watcher tick will re-evaluate.
  if (state.swapInFlight) {
    return { ok: true, skipped: true };
  }

  // No-op when the new identity matches what's already bound AND the prior
  // swap (if any) succeeded. A failed prior swap stays "stale" — caller
  // should retry the full routine, not skip.
  const nextBound: BoundTarget = { host: next.host, port: next.port, label: next.label };
  if (
    targetsEqual(state.boundTarget, nextBound) &&
    state.lastSwapError === null
  ) {
    // Refresh the bound version so /load/status reflects the latest
    // monotonic counter from the api even when no rebind was needed.
    state.boundVersion = next.version;
    // Clear stale if we previously flagged it on a divergent poll that has
    // since converged onto the bound target.
    if (state.targetStale) {
      state.targetStale = false;
      state.targetStaleReason = null;
    }
    return { ok: true };
  }

  state.swapInFlight = true;
  // Synchronously slam accepting=false so a /load/rows arriving while the
  // swap is still in flight cannot land on the about-to-be-torn-down pool.
  state.accepting = false;
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const old = state.boundTarget;
  const log = deps.logger;
  log.info(
    { from_label: old.label, from_host: old.host, from_port: old.port, to_label: next.label, to_host: next.host, to_port: next.port, version: next.version },
    "target swap starting",
  );
  try {
    // 1. Drain the dispatcher with a hard cap. Anything still queued past
    //    the cap is left to settle (or be lost) against the OLD pool — the
    //    spec says abort the swap, NOT force-close, so in-flight rows still
    //    have a chance to land before the new pool replaces them.
    if (state.dispatcher) {
      const drained = await withTimeout(state.dispatcher.drain(), drainTimeoutMs);
      if (drained.timedOut) {
        const reason = `dispatcher drain exceeded ${drainTimeoutMs}ms`;
        state.lastSwapError = reason;
        log.warn(
          { from_label: old.label, drain_timeout_ms: drainTimeoutMs },
          "target swap aborted — drain timed out",
        );
        // accepting stays false so /load/rows fails loud.
        state.targetStale = true;
        state.targetStaleReason = formatStaleReason(old, nextBound, false);
        return { ok: false, reason };
      }
    }

    // 2. Stop the checkpointer (final flush) and dispatcher + pool before
    //    building the new triple. Each is wrapped so a failing teardown of
    //    one component still tries to tear down the rest.
    try { if (state.checkpointer) await state.checkpointer.stop(); }
    catch (err) { log.warn({ err: String(err) }, "checkpointer stop failed during swap"); }
    try { if (state.dispatcher) await state.dispatcher.stop(); }
    catch (err) { log.warn({ err: String(err) }, "dispatcher stop failed during swap"); }
    try { await state.pool.stop(); }
    catch (err) { log.warn({ err: String(err) }, "pool stop failed during swap"); }

    // 3. Build the new pool / dispatcher / checkpointer triple. If this
    //    throws (resolveRedisTarget failed, connection refused, etc.) we
    //    record last_swap_error, leave accepting=false, and bail. The next
    //    watcher tick can retry.
    let built: RebuiltRuntime;
    try {
      built = await deps.rebuildFromTarget(next);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      state.lastSwapError = `rebuild failed: ${reason}`;
      // The old pool is already torn down at this point. We have no live
      // pool to fall back to; accepting stays false and the state's pool
      // ref still points at the (now-stopped) old instance so /load/status
      // can still report the previously-bound identity. The next swap will
      // build a fresh pool.
      state.targetStale = true;
      state.targetStaleReason = formatStaleReason(old, nextBound, false);
      log.error(
        { from_label: old.label, to_label: next.label, err: reason },
        "target swap failed — rebuild errored",
      );
      return { ok: false, reason: state.lastSwapError };
    }

    // 4. Atomic swap of the runtime pointers. After this line, /load/rows
    //    enqueues land on the new pool's workers.
    state.pool = built.pool;
    state.dispatcher = built.dispatcher;
    state.checkpointer = built.checkpointer;
    state.bootstrapCheckpoints = built.bootstrapCheckpoints;
    state.boundTarget = { ...nextBound };
    state.boundVersion = next.version;
    state.targetSwapCount++;
    state.lastSwapError = null;
    state.targetStale = false;
    state.targetStaleReason = null;
    // Refresh the api snapshot to reflect that we just adopted it.
    state.apiActiveTarget = { ...nextBound };
    state.apiActiveTargetVersion = next.version;
    state.accepting = true;
    log.info(
      {
        from_label: old.label, from_host: old.host, from_port: old.port,
        to_label: next.label, to_host: next.host, to_port: next.port,
        version: next.version, swap_count: state.targetSwapCount,
      },
      "target swap complete",
    );
    return { ok: true };
  } finally {
    state.swapInFlight = false;
  }
}
