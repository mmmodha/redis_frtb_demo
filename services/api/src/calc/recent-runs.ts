// Wave 6.01 — Process-local ring buffer of recently-served /calc/sbm and
// /calc/sbm/total responses, surfaced via GET /calc/recent for the
// Observability "Last Calculation" card. In-memory only (mirrors the
// short-TTL response cache in sbm/calc-cache.ts — no Redis persistence per
// the locked non-goals); cleared on every active-target switch so a profile
// flip never replays another target's runs.

import { ulid } from "ulid";
import { onActiveTargetChange } from "../active-target.ts";

const CAPACITY = 20;

// Discriminated by `kind` so the UI can render distinct metric tile sets
// without inspecting payload shape. `cache` is present on every kind so the
// header tile can flag cold-vs-warm in one place; `engine` is the badge
// string (fast/lua for per_class, "orchestrator" for total).
export interface RecentRunCommon {
  id: string;
  ts: string;
  charge: number;
  total_ms: number;
  cache: "hit" | "miss";
  engine: string;
}

export interface RecentRunPerClass extends RecentRunCommon {
  kind: "per_class";
  risk_class: string;
  leg: string;
  scenario?: string;
  fanout_ms: number;
  cells_evaluated: number;
}

export interface RecentRunTotal extends RecentRunCommon {
  kind: "total";
  cumulative_ms: number;
  parallelism_factor: number;
  redis_ops_count: number;
  ops_skipped: number;
  cells_empty: number;
  cache_hits: number;
}

export type RecentRunEntry = RecentRunPerClass | RecentRunTotal | RecentRunFailed;

export interface RecentRunFailed {
  kind: "failed";
  id: string;
  ts: string;
  calc_kind: "per_class" | "total";
  risk_class?: string;
  leg?: string;
  error: string;
  status_code: number;
  request_id?: string;
}

// Caller-supplied input — id / ts are filled in here so every entry carries
// a consistent ulid + server-stamped iso timestamp regardless of where in
// the route the push happens.
export type RecentRunInput =
  | Omit<RecentRunPerClass, "id" | "ts">
  | Omit<RecentRunTotal, "id" | "ts">;

// Newest-front semantics: index 0 is the most recent push. Bounded splice
// keeps the array length at exactly CAPACITY without churn beyond it.
const buffer: RecentRunEntry[] = [];

onActiveTargetChange(() => {
  buffer.length = 0;
});

export function pushRecentRun(input: RecentRunInput): RecentRunEntry {
  const entry: RecentRunEntry = {
    ...input,
    id: ulid(),
    ts: new Date().toISOString(),
  } as RecentRunEntry;
  buffer.unshift(entry);
  if (buffer.length > CAPACITY) buffer.length = CAPACITY;
  return entry;
}

export function pushRecentFailure(
  input: Omit<RecentRunFailed, "id" | "ts" | "kind">,
): RecentRunFailed {
  const entry: RecentRunFailed = {
    kind: "failed",
    id: ulid(),
    ts: new Date().toISOString(),
    ...input,
  };
  buffer.unshift(entry);
  if (buffer.length > CAPACITY) buffer.length = CAPACITY;
  return entry;
}

export function listRecentRuns(limit: number): RecentRunEntry[] {
  const n = Math.max(0, Math.min(limit, CAPACITY));
  return buffer.slice(0, n);
}

// Test-only reset; module-global state otherwise persists across cases.
export function __resetRecentRunsForTests(): void {
  buffer.length = 0;
}

export const RECENT_RUNS_CAPACITY = CAPACITY;
