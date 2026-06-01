// Wave 5.21g — shared pivot fetch + timing helper used by the global
// PivotBurstContext. PivotPanel keeps its inline runAt for filter-driven
// runs (its error rendering shape is asserted by existing tests); this
// helper exists so the burst loop can keep running across route changes
// without depending on panel-local state or fetch closures.

import { apiBase } from "./api";
import {
  EmptyTargetError,
  checkEmptyTargetError,
  readErrorBody,
} from "./empty-target";
import type { PivotResp } from "./pivot";

export interface PivotRunFilters {
  risk_class?: string;
  bucket?: string;
  sensitivity_type?: string;
  book?: string;
  limit?: number;
  offset?: number;
}

export interface PivotRunResult {
  body: PivotResp;
  clientMs: number;
}

export async function runPivot(
  filters: PivotRunFilters,
  signal?: AbortSignal,
): Promise<PivotRunResult> {
  const params = new URLSearchParams();
  if (filters.risk_class) params.set("risk_class", filters.risk_class);
  if (filters.bucket) params.set("bucket", filters.bucket);
  if (filters.sensitivity_type) params.set("sensitivity_type", filters.sensitivity_type);
  if (filters.book) params.set("book", filters.book);
  params.set("limit", String(filters.limit ?? 100));
  params.set("offset", String(filters.offset ?? 0));
  const url = `${apiBase().replace(/\/$/, "")}/pivot?${params.toString()}`;
  const t0 = performance.now();
  const res = await fetch(url, signal ? { signal } : undefined);
  const t1 = performance.now();
  if (!res.ok) {
    const friendly = checkEmptyTargetError(res.status, await readErrorBody(res));
    if (friendly) throw friendly;
    throw new Error(`Pivot failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as PivotResp;
  return { body, clientMs: Math.round((t1 - t0) * 1000) / 1000 };
}

export { EmptyTargetError };
