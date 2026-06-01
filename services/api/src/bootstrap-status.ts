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
import { bootstrapFrtb, type RedisLike as BootstrapRedis } from "./bootstrap.ts";

export type BootstrapPhase = "idle" | "running" | "ready" | "failed";

export interface BootstrapStatusSnapshot {
  phase: BootstrapPhase;
  target_label?: string;
  started_at?: string;
  finished_at?: string;
  err?: string;
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

type BootstrapRunner = (client: BootstrapRedis, schema: Schema) => Promise<unknown>;
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
    runner(client, schema)
      .then(() => {
        if (myGen !== generation) return;
        markBootstrapStatusReady(target.label);
      })
      .catch((err: unknown) => {
        if (myGen !== generation) return;
        markBootstrapStatusFailed(target.label, err);
      });
  }, debounceMs);
}
