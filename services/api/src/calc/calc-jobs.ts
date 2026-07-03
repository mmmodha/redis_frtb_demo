// Wave 7.2 — in-process registry of in-flight calc requests for Admin /
// Observability polling. Mirrors the generator `activeRuns` pattern but
// tracks POST /calc/sbm and /calc/sbm/total with cell/bucket progress.

import { ulid } from "ulid";
import { onActiveTargetChange } from "../active-target.ts";

export type CalcJobKind = "per_class" | "total";
export type CalcJobStatus = "running" | "done" | "error";

export interface CalcJobEntry {
  id: string;
  kind: CalcJobKind;
  status: CalcJobStatus;
  started_at: string;
  finished_at?: string;
  request_id?: string;
  risk_class?: string;
  leg?: string;
  /** Orchestrator cells (total) or buckets (per_class fan-out). */
  cells_total: number;
  cells_done: number;
  current_cell?: string;
  error?: string;
  status_code?: number;
}

const TERMINAL_GRACE_MS = 30_000;
const active = new Map<string, CalcJobEntry>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

onActiveTargetChange(() => {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  active.clear();
});

export interface StartCalcJobInput {
  kind: CalcJobKind;
  request_id?: string;
  risk_class?: string;
  leg?: string;
  cells_total?: number;
}

export function startCalcJob(input: StartCalcJobInput): CalcJobEntry {
  const entry: CalcJobEntry = {
    id: ulid(),
    kind: input.kind,
    status: "running",
    started_at: new Date().toISOString(),
    request_id: input.request_id,
    risk_class: input.risk_class,
    leg: input.leg,
    cells_total: input.cells_total ?? (input.kind === "total" ? 27 : 1),
    cells_done: 0,
  };
  active.set(entry.id, entry);
  return entry;
}

export function updateCalcJob(
  id: string,
  patch: Partial<Pick<CalcJobEntry, "cells_done" | "cells_total" | "current_cell">>,
): void {
  const e = active.get(id);
  if (!e || e.status !== "running") return;
  if (patch.cells_done !== undefined) e.cells_done = patch.cells_done;
  if (patch.cells_total !== undefined) e.cells_total = patch.cells_total;
  if (patch.current_cell !== undefined) e.current_cell = patch.current_cell;
}

export function finishCalcJob(
  id: string,
  outcome: { status: "done" } | { status: "error"; error: string; status_code?: number },
): void {
  const e = active.get(id);
  if (!e) return;
  e.status = outcome.status;
  e.finished_at = new Date().toISOString();
  if (outcome.status === "error") {
    e.error = outcome.error;
    e.status_code = outcome.status_code;
  }
  const prev = timers.get(id);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    active.delete(id);
    timers.delete(id);
  }, TERMINAL_GRACE_MS);
  t.unref?.();
  timers.set(id, t);
}

export function listActiveCalcJobs(): CalcJobEntry[] {
  return Array.from(active.values());
}

export function getCalcJob(id: string): CalcJobEntry | undefined {
  return active.get(id);
}

export function __resetCalcJobsForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  active.clear();
}
