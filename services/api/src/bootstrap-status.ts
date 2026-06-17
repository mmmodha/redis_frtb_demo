// Wave 5.16t — bootstrap status tracker + debounced scheduler.
//
// When the operator activates a different connection profile via the UI, the
// new target may not yet have `idx:sens` or the `frtb` Lua library loaded. We
// kick bootstrapFrtb() in the background and publish phase progress so the UI
// can render "bootstrapping…" / "ready" / "failed" without polling Redis
// directly.
//
// Idempotent: a `ready` snapshot for the same target_label short-circuits.
// Re-entrant: a switch mid-run cancels the in-flight via a generation counter
// so its eventual resolution doesn't overwrite the newer attempt's status.

import type { Schema } from "@frtb/schema";
import type { ActiveTarget } from "./active-target.ts";
import {
  bootstrapFrtb,
  BootstrapPartialError,
  type BootstrapFailure,
  type BootstrapOpts,
  type RedisLike as BootstrapRedis,
} from "./bootstrap.ts";
import { withBootTimeout } from "./lib/with-timeout.ts";
// Wave 6.18k — pair every phase-tracker terminal write with a /readyz flip
// so /readyz and /redis/active-target/bootstrap-status can never disagree
// (the boot-time path in index.ts:191-214 already does this; the listener
// path was missing it, so a stale boot-time `failed` could coexist with
// a fresh `ready` phase). Circular import is safe: both modules only use
// the imported bindings inside function bodies, not at module init.
import {
  markBootstrapReady,
  markBootstrapFailed,
} from "./server.ts";

// Wave 6.18h — scheduled-path timeout shares the boot-time helper but uses
// a longer default. The boot path (index.ts, 12s) blocks `app.listen` so
// it has to stay short; this listener-driven path runs post-listen and only
// protects against the bootstrap-status snapshot leaking `running`. FT.DROPINDEX
// on a 100M-row index can legitimately take 30-60s, so 12s here would cause
// spurious failures during the demo. Override with SCHEDULED_BOOTSTRAP_TIMEOUT_MS.
const DEFAULT_SCHEDULED_BOOTSTRAP_TIMEOUT_MS = 90_000;
function getScheduledBootstrapTimeoutMs(): number {
  const raw = process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
}

// Wave 6.16a — `partial` slots between `ready` and `failed`: at least one
// per-node step (idx:sens, frtb library) refused to come up, but the
// overall fan-out completed. /admin/rebuild-indexes can transition this
// back to `ready` once the underlying node recovers.
export type BootstrapPhase = "idle" | "running" | "ready" | "partial" | "failed";

export interface BootstrapStatusSnapshot {
  phase: BootstrapPhase;
  target_label?: string;
  started_at?: string;
  finished_at?: string;
  err?: string;
  // Populated only when phase === "partial". Empty/omitted otherwise.
  failures?: BootstrapFailure[];
}

let status: BootstrapStatusSnapshot = { phase: "idle" };
let generation = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let debounceMs = 250;

export function getBootstrapStatus(): BootstrapStatusSnapshot {
  return { ...status };
}

// Test-only seam — reset state between cases so prior runs don't leak.
export function resetBootstrapStatusForTests(): void {
  status = { phase: "idle" };
  generation = 0;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  debounceMs = 250;
  runner = bootstrapFrtb;
}

// Test-only seam — shrink the debounce window so unit tests stay fast.
export function setDebounceMsForTests(ms: number): void {
  debounceMs = ms;
}

export function markBootstrapStatusRunning(target_label: string): void {
  generation += 1;
  status = { phase: "running", target_label, started_at: new Date().toISOString() };
}

export function markBootstrapStatusReady(target_label: string): void {
  const prev = status;
  status = {
    phase: "ready",
    target_label,
    finished_at: new Date().toISOString(),
    ...(prev.started_at ? { started_at: prev.started_at } : {}),
  };
}

export function markBootstrapStatusFailed(target_label: string, err: unknown): void {
  const prev = status;
  status = {
    phase: "failed",
    target_label,
    finished_at: new Date().toISOString(),
    err: String(err instanceof Error ? err.message : err),
    ...(prev.started_at ? { started_at: prev.started_at } : {}),
  };
}

// Wave 6.16a — fan-out completed but at least one node refused a step
// (idx:sens drop/create, FUNCTION LOAD). Distinct from `failed` (the
// whole run blew up): per-call routes still work against the healthy
// shards, while operators get a structured list of nodes to remediate
// via /admin/rebuild-indexes.
export function markBootstrapStatusPartial(
  target_label: string,
  failures: BootstrapFailure[],
): void {
  const prev = status;
  const summary = failures.map((f) => `${f.step}@${f.node_id}`).join(", ");
  status = {
    phase: "partial",
    target_label,
    finished_at: new Date().toISOString(),
    err: `bootstrap partial: ${failures.length} per-node step(s) failed: ${summary}`,
    failures,
    ...(prev.started_at ? { started_at: prev.started_at } : {}),
  };
}

// Wave 6.18i — runner type carries the BootstrapOpts third arg so
// scheduleBootstrap can plumb `target_label` through to the
// skip-when-unchanged path. Existing test seams that ignore opts still
// satisfy the type (TS permits dropping trailing optional params).
type BootstrapRunner = (
  client: BootstrapRedis,
  schema: Schema,
  log?: (entry: Record<string, unknown>) => void,
  opts?: BootstrapOpts,
) => Promise<unknown>;
let runner: BootstrapRunner = bootstrapFrtb;
export function setBootstrapRunnerForTests(fn: BootstrapRunner | null): void {
  runner = fn ?? bootstrapFrtb;
}

// Schedule a background bootstrap against `target` using `client`. Debounced
// so rapid switch-clicks coalesce, idempotent on same-target ready, and
// generation-gated so an in-flight earlier attempt's late resolution can't
// overwrite a newer attempt's phase.
export function scheduleBootstrap(
  target: ActiveTarget,
  client: BootstrapRedis | null,
  schema: Schema | undefined,
): void {
  if (!client || !schema) return;
  if (status.phase === "ready" && status.target_label === target.label) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  // Wave 5.16y — synchronously bump generation and flip to "running" so a
  // stale "failed" snapshot from a prior target doesn't linger during the
  // debounce window. The setTimeout below still gates the actual runner
  // invocation so rapid switch-clicks coalesce.
  generation += 1;
  const myGen = generation;
  status = { phase: "running", target_label: target.label, started_at: new Date().toISOString() };
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Skip if a newer schedule call superseded us during debounce.
    if (myGen !== generation) return;
    // Wave 6.18h — bound the runner with the shared withBootTimeout helper
    // so a hung bootstrapFrtb (e.g. FT.DROPINDEX wedged on a large index,
    // network partition mid-fan-out) can't leak the snapshot stuck at
    // `running`. Default 90s gives FT.DROPINDEX on a 100M-row index room
    // to legitimately complete; override via SCHEDULED_BOOTSTRAP_TIMEOUT_MS.
    // See index.ts BOOT_BOOTSTRAP_TIMEOUT_MS (12s) for the asymmetric
    // boot-time twin — boot-time blocks app.listen so it MUST stay short.
    const ms = getScheduledBootstrapTimeoutMs();
    let runnerSettled = false;
    // Wave 6.18i — pass target_label so bootstrapFrtb takes the
    // versioned-index skip path; an unchanged schema short-circuits
    // without firing the ~22-minute DROPINDEX cycle.
    const wrapped = runner(client, schema, undefined, { target_label: target.label })
      .finally(() => { runnerSettled = true; });
    withBootTimeout(wrapped, ms, "scheduled-bootstrap")
      .then(() => {
        if (myGen !== generation) return;
        markBootstrapStatusReady(target.label);
        // Wave 6.18k — also flip /readyz to match phase tracker
        markBootstrapReady();
      })
      .catch((err: unknown) => {
        if (myGen !== generation) return;
        // Wave 6.18h — distinguish a withBootTimeout firing (runner still
        // pending) from a genuine runner rejection. The flag flips inside
        // .finally so by the time the runner's rejection propagates to
        // withBootTimeout's catch, runnerSettled is already true.
        if (!runnerSettled) {
          const timeoutErr = new Error(`scheduled-bootstrap-timeout: exceeded ${ms}ms`);
          console.log(JSON.stringify({
            service: "api",
            bootstrap: "frtb",
            action: "scheduled-bootstrap-timeout",
            target_label: target.label,
            ms,
          }));
          markBootstrapStatusFailed(target.label, timeoutErr);
          // Wave 6.18k — also flip /readyz to match phase tracker
          markBootstrapFailed(timeoutErr);
          return;
        }
        // Wave 6.16a — separate the partial-fan-out case from generic
        // failures so the UI / operators can distinguish "rebuild this
        // node" from "the whole target is unreachable".
        if (err instanceof BootstrapPartialError) {
          markBootstrapStatusPartial(target.label, err.failures);
          // Wave 6.18k — also flip /readyz to match phase tracker
          // (mirrors index.ts:209-214: boot path calls markBootstrapFailed
          // for partial too — /readyz is binary, partial is exposed via
          // the bootstrap-status snapshot for operator drill-down).
          markBootstrapFailed(err);
          return;
        }
        markBootstrapStatusFailed(target.label, err);
        // Wave 6.18k — also flip /readyz to match phase tracker
        markBootstrapFailed(err);
      });
  }, debounceMs);
}
