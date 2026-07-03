// Wave 7.2 — ring buffer of recent API errors for Admin diagnostics.
// Populated by the global error handler and explicit route failures.

import { onActiveTargetChange } from "../active-target.ts";
import { appendLog } from "./log-buffer.ts";

const CAPACITY = 50;

export interface RecentErrorEntry {
  id: string;
  ts: string;
  request_id: string;
  method: string;
  route: string;
  status_code: number;
  error: string;
  detail?: string;
}

const buffer: RecentErrorEntry[] = [];
let seq = 0;

onActiveTargetChange(() => {
  buffer.length = 0;
});

export function pushRecentError(input: Omit<RecentErrorEntry, "id" | "ts">): RecentErrorEntry {
  const entry: RecentErrorEntry = {
    ...input,
    id: `err_${++seq}`,
    ts: new Date().toISOString(),
  };
  buffer.unshift(entry);
  if (buffer.length > CAPACITY) buffer.length = CAPACITY;
  appendLog({
    level: "error",
    msg: input.error,
    request_id: input.request_id,
    status_code: input.status_code,
    route: input.route,
  });
  return entry;
}

export function listRecentErrors(limit: number): RecentErrorEntry[] {
  const n = Math.max(0, Math.min(limit, CAPACITY));
  return buffer.slice(0, n);
}

export function __resetRecentErrorsForTests(): void {
  buffer.length = 0;
  seq = 0;
}
