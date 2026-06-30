// Wave 6.39.D — typed clients for the Layer 4 admin observability
// endpoints exposed by services/api/src/routes/admin-calc.ts (Wave 6.39.B)
// and services/api/src/routes/admin-l4.ts (Wave 6.39.C). Kept in its own
// module so the rest of the UI doesn't pull observability shapes through
// lib/api.ts (which is owned by the Observability tab task).

import { apiBase } from "./api";

export type DriftSensitivity = "Delta" | "Vega" | "Curvature";
export type DriftStatusKind = "ok" | "drift";

// GET /admin/calc-coverage — Wave 6.39.B
export interface CoverageRow {
  risk_class: string;
  bucket: string;
  sens_type: string;
  rollup_present: boolean;
  sens_doc_count: number;
}
export interface CoverageSummary { total: number; present: number; missing: number }
export interface CalcCoverageResponse { coverage: CoverageRow[]; summary: CoverageSummary }

// GET /admin/drift-status — Wave 6.39.C
export interface DriftResult {
  ts: string;
  bucket: string;
  risk_class: string;
  sensitivity_type: DriftSensitivity;
  rollup_sum: number;
  recomputed_sum: number;
  drift_pct: number;
  status: DriftStatusKind;
}
export interface DriftStatusResponse { threshold_pct: number; results: DriftResult[] }

// GET /admin/snapshots — Wave 6.39.C
export interface SnapshotSummary { ts: string; key_count: number }
export interface SnapshotsResponse { snapshots: SnapshotSummary[] }

// GET /admin/stream-status — Wave 6.39.C
// Wave 6.41.E.fix3 — adds `consumed`, a strictly-monotonic counter sourced
// from the ingest service (`ingest:consumed:<stream>` key). The IngestPanel
// indexing bar reads it so unbounded streams (stream_maxlen=0) still show
// drain progress. Optional for forward/back compat with older api builds.
export interface StreamStatusResponse {
  stream_key: string;
  xlen: number;
  maxlen: number;
  peak_rate_per_sec: number;
  retention_hours_now: number;
  retention_hours_at_cap: number;
  consumed?: number;
}

// POST /admin/reconcile-bucket — Wave 6.39.C
export interface ReconcileBucketRequest {
  risk_class: string;
  bucket: string;
  sensitivity_type: DriftSensitivity;
  admin_token: string;
}
export interface ReconcileBucketResponse {
  ok: true;
  before_sum: number;
  after_sum: number;
  drift_pct: number;
  risk_class: string;
  bucket: string;
  sensitivity_type: DriftSensitivity;
}

// POST /admin/ingest-capacity-test — Wave 7.0.9
export type CapacityBottleneck =
  | "redis_write"
  | "bulk_loader_queue"
  | "balanced"
  | "under_utilized";

export type CapacityStepVerdict = "optimal" | "under_utilized" | "saturated";

export interface CapacityStepResult {
  workers: number;
  gen_rps: number;
  write_rps: number;
  throttled_samples: number;
  total_samples: number;
  recent_429_max: number;
  duration_ms: number;
  rows_sent: number;
  verdict: CapacityStepVerdict;
}

export interface CapacityTestResult {
  ok: true;
  target_label: string | null;
  deployment: {
    cores: number;
    recommended_max_workers: number;
    bulk_loader_pool_size: number;
    bulk_loader_replicas: number;
    bulk_loader_instance_ids?: string[];
    recommended_bulk_loader_replicas: number;
    shards: number | null;
  };
  worker_sweep: number[];
  rows_per_step: number;
  steps: CapacityStepResult[];
  recommended_workers: number;
  bottleneck: CapacityBottleneck;
  notes: string[];
  total_ms: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = `${res.status}: ${body.error}`;
    } catch { /* not json */ }
    throw new Error(`api ${path} ${detail}`);
  }
  return (await res.json()) as T;
}

export function getCalcCoverage(): Promise<CalcCoverageResponse> {
  return getJson<CalcCoverageResponse>("/admin/calc-coverage");
}
export function getDriftStatus(): Promise<DriftStatusResponse> {
  return getJson<DriftStatusResponse>("/admin/drift-status");
}
export function getSnapshots(): Promise<SnapshotsResponse> {
  return getJson<SnapshotsResponse>("/admin/snapshots");
}
export function getStreamStatus(): Promise<StreamStatusResponse> {
  return getJson<StreamStatusResponse>("/admin/stream-status");
}

export async function postIngestCapacityTest(
  body: { rows_per_step?: number; worker_sweep?: number[] } = {},
): Promise<CapacityTestResult> {
  const res = await fetch(`${apiBase()}/admin/ingest-capacity-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody?.error) detail = `${res.status}: ${errBody.error}`;
    } catch { /* not json */ }
    throw new Error(`api /admin/ingest-capacity-test ${detail}`);
  }
  return (await res.json()) as CapacityTestResult;
}

export async function postReconcileBucket(
  req: ReconcileBucketRequest,
): Promise<ReconcileBucketResponse> {
  const { admin_token, ...body } = req;
  const res = await fetch(`${apiBase()}/admin/reconcile-bucket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": admin_token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody?.error) detail = `${res.status}: ${errBody.error}`;
    } catch { /* not json */ }
    throw new Error(`api /admin/reconcile-bucket ${detail}`);
  }
  return (await res.json()) as ReconcileBucketResponse;
}

// Admin token persistence — localStorage only, never the URL. Defaults to
// empty so the reconcile form starts blocked until the operator types or
// pastes a token.
//
// Wave 6.44.B audit — intentionally global (not target-scoped). The admin
// token is shared shell credential of the operator, not a per-cluster
// secret; partitioning by target label would force the operator to re-paste
// it on every switch with no security benefit.
export const ADMIN_TOKEN_STORAGE_KEY = "frtb.admin.token";

export function loadAdminToken(): string {
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "";
  } catch { return ""; }
}
export function saveAdminToken(token: string): void {
  try { window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token); }
  catch { /* localStorage unavailable */ }
}
export function clearAdminToken(): void {
  try { window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY); }
  catch { /* localStorage unavailable */ }
}
