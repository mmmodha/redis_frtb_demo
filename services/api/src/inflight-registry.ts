// Wave 5.16w — in-flight operations registry.
//
// Process-local singleton tracking long-running operations (loadgen runs,
// source ingests) so /connections/:id/activate can REJECT mid-flight target
// switches that would corrupt observability or strand the in-flight run.
//
// Restart semantics: not persisted. A crash/restart clears the registry — a
// forgotten in-flight that survived process death should never block future
// switches forever. Stale eviction (entries older than INFLIGHT_STALE_MS,
// default 60s) provides the same liveness guarantee within a single process.

import { ulid } from "ulid";

export type InflightKind = "loadgen" | "ingest";

export interface InflightEntry {
  id: string;
  kind: InflightKind;
  label: string;
  started_at: number;
}

export interface InflightHandle {
  id: string;
  release(): void;
}

export interface InflightSnapshot {
  count: number;
  items: InflightEntry[];
  stale: InflightEntry[];
}

export type InflightListener = (snap: InflightSnapshot) => void;

function staleMs(): number {
  const raw = process.env.INFLIGHT_STALE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

const entries = new Map<string, InflightEntry>();
const listeners = new Set<InflightListener>();

function notify(): void {
  const snap = snapshot();
  for (const fn of listeners) {
    try { fn(snap); } catch { /* listener errors must not break the registry */ }
  }
}

export function register(
  kind: InflightKind,
  label: string,
  opts?: { started_at?: number },
): InflightHandle {
  const id = ulid();
  const entry: InflightEntry = {
    id,
    kind,
    label,
    started_at: opts?.started_at ?? Date.now(),
  };
  entries.set(id, entry);
  notify();
  let released = false;
  return {
    id,
    release(): void {
      if (released) return;
      released = true;
      if (entries.delete(id)) notify();
    },
  };
}

// All non-stale entries. These BLOCK activation.
export function list(): InflightEntry[] {
  const cutoff = Date.now() - staleMs();
  return Array.from(entries.values()).filter((e) => e.started_at >= cutoff);
}

// Entries past the stale threshold. Surfaced in the 409 payload so the UI
// can render a "force switch" affordance later (out of scope for this task).
export function listStale(): InflightEntry[] {
  const cutoff = Date.now() - staleMs();
  return Array.from(entries.values()).filter((e) => e.started_at < cutoff);
}

export function count(): number {
  return list().length;
}

export function snapshot(): InflightSnapshot {
  return { count: count(), items: list(), stale: listStale() };
}

export function onChange(fn: InflightListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Test-only seam — clears all entries and listeners so prior runs don't leak.
export function resetInflightRegistryForTests(): void {
  entries.clear();
  listeners.clear();
}
