// Typed client for the MVP `POST /calc/sbm` endpoint.
// Contract restated from spec ("Wave 2 contracts (locked)"):
//   request:  { risk_class, sensitivity_type }
//   response: { charge, per_bucket[], total_ms, shard_breakdown[], fanout_ms }

import { apiBase } from "./api";
import { buildApiError } from "./empty-target";

export type SensitivityType = "Delta" | "Vega" | "Curvature";

// Wave 5.31b: Basel MAR21.6 cross-bucket γ regime selector. "medium" is the
// pre-5.31b default; "low" scales γ by 0.75, "high" by 1.25 with each ρ_bc
// capped symmetrically at ±1.0.
export type CorrelationRegime = "low" | "medium" | "high";

export interface CalcSbmRequest {
  risk_class: string;
  sensitivity_type: SensitivityType;
  // Wave 5.31a: optional discovery-layer narrowing. When present and non-empty,
  // the api restricts the FT.AGGREGATE bucket discovery to this subset so only
  // those buckets get FCALL fan-out. Omit (or send []) for a full-portfolio run.
  bucket_subset?: string[];
  // Wave 5.31b: omit to inherit the api default ("medium"). The UI only sends
  // a value when it's non-default so the commands panel stays clean.
  correlation_regime?: CorrelationRegime;
  // Wave 5.31c: optional kernel-side row-exclusion predicate. Each list is
  // marshalled into a CSV positional FCALL arg inside the api; omit entirely
  // or send empty lists for the byte-identical pre-5.31c kernel path.
  exclude?: {
    book?: string[];
    trade_id?: string[];
    risk_factor?: string[];
  };
  // Wave 6.41.C — positive-include predicate mirroring the api's CalcBody.include
  // shape (services/api/src/routes/calc.ts): when any list is non-empty the
  // kernel keeps only rows whose value is IN the list. `region` resolves to a
  // desk-set on the api side; `bucket` accepts integer bucket ids.
  include?: {
    book?: string[];
    trade_id?: string[];
    desk?: string[];
    region?: string[];
    bucket?: number[];
  };
}

// Wave 5.96A — per-bucket drilldown intermediates. Populated by the FT.AGGREGATE
// fast path so the UI can render the "How K_b was calculated" formula block
// with substituted numbers; absent (or `path: "lua"`) on the legacy FCALL path,
// where the intermediates are computed inside the kernel and not surfaced.
export type BucketPath = "fast" | "lua";
// Wave 5.96A.1 — per-component breakdown so the drilldown UI can render the
// individual WS_k / WS_k² + dominant pairwise contribs that summed into
// ws_squared_sum and cross_term.
export interface WsComponent {
  k: string;
  ws: number;
  ws_squared: number;
}
export interface CrossComponent {
  k: string;
  l: string;
  rho: number;
  ws_k: number;
  ws_l: number;
  contrib: number;
}
export interface CvrComponent {
  k: string;
  cvr_up: number;
  cvr_down: number;
}
export interface BucketCurvatureIntermediate {
  k_plus: number;
  k_minus: number;
  winner: "plus" | "minus";
  // Wave 5.96A.1 — per-risk-factor CVR pairs whose signed sums precede the
  // §21.5(3) max selection.
  cvr_components?: CvrComponent[];
}
export interface BucketIntermediate {
  path: BucketPath;
  ws_squared_sum?: number;
  cross_term?: number;
  curvature?: BucketCurvatureIntermediate;
  // Wave 5.96A.1 — additive per-component arrays. Present on the fast path
  // with the top-10 cross_components by |contrib| and a truncation flag so
  // the UI can fetch the full list via /calc/sbm/bucket-cross-detail.
  ws_components?: WsComponent[];
  cross_components?: CrossComponent[];
  cross_components_truncated?: boolean;
  cross_components_total_count?: number;
}
export interface BucketResult {
  bucket: string;
  K_b: number;
  S_b: number;
  count: number;
  ms: number;
  // Wave 5.96A — both optional for forward-compat with older /calc/sbm responses.
  intermediate?: BucketIntermediate;
  resolved_command?: string;
}

export interface ShardBreakdownEntry {
  shard: string;
  buckets: string[];
  ms: number;
}

// Wave 5.16m: read-only mirror of the Redis commands the api dispatched
// (FT.AGGREGATE for discovery, FCALL per bucket for fan-out). Optional on
// CalcSbmResponse so older api responses still parse during rolling deploys.
export interface CalcCommands {
  discovery: {
    command: "FT.AGGREGATE";
    index: string;
    query: string;
    groupby: string[];
    reducers: string[];
  };
  fcall: {
    command: "FCALL";
    function: string;
    library: string;
    arg_template: string;
    dispatched_keys: string[];
  };
  // Wave 5.31b: §21.6 regime block. Optional so older api responses still parse.
  regime?: {
    name: CorrelationRegime;
    factor: number;
    cap: number;
    note: string;
  };
}

// Wave 5.83C-1 — engine label echoed from the api so the UI can render the
// "via FT.AGGREGATE" / "via FCALL (Lua)" badge.
export type CalcEngine = "ft_aggregate" | "fcall_lua";
// Wave 5.83C-2 — short-TTL response cache markers stamped onto every response.
export type CalcCacheState = "hit" | "miss";

export interface CalcSbmResponse {
  charge: number;
  per_bucket: BucketResult[];
  total_ms: number;
  shard_breakdown: ShardBreakdownEntry[];
  fanout_ms: number;
  commands?: CalcCommands;
  // Wave 5.19: present only on Curvature responses. Identifies which
  // §21.5(5) branch produced the charge — primary positive-interior path or
  // the §21.5(5)(b) S_b-clipped fallback when the interior went negative.
  curvature_branch?: "positive_interior" | "fallback_clipped_s";
  // Wave 5.31b: echoed regime that was applied (low/medium/high). Optional
  // for forward-compat with older api responses.
  correlation_regime?: CorrelationRegime;
  // Wave 5.83C-1 / 5.83D-2: engine + cache markers feeding the calc-engine-pill.
  // Both optional so older api responses still parse.
  engine?: CalcEngine;
  cache?: CalcCacheState;
  cached_at_iso?: string;
  // Wave 5.96F — on cache hits, `total_ms` / `fanout_ms` are the freshly
  // measured hit elapsed (expected <100 ms); these fields preserve the cold-
  // compute cost from when the cache entry was first written so the chip can
  // render "Computed in 21.05 s (cached, served in 12 ms)". Absent on misses.
  original_compute_ms?: number;
  original_fanout_ms?: number;
}

export async function postCalcSbm(body: CalcSbmRequest): Promise<CalcSbmResponse> {
  const res = await fetch(`${apiBase()}/calc/sbm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await buildApiError(res, `api /calc/sbm ${res.status}`);
  }
  return (await res.json()) as CalcSbmResponse;
}

// Wave 5.96A.1 — full cross-component listing for a single bucket. The
// /calc/sbm response caps cross_components at the top-10 by |contrib|; the
// drilldown's "Show all" toggle calls this to fetch the complete pair list.
export interface BucketCrossDetailRequest extends CalcSbmRequest {
  bucket: string;
}
export interface BucketCrossDetailResponse {
  bucket: string;
  cross_components: CrossComponent[];
}
export async function postBucketCrossDetail(
  body: BucketCrossDetailRequest,
): Promise<BucketCrossDetailResponse> {
  const res = await fetch(`${apiBase()}/calc/sbm/bucket-cross-detail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await buildApiError(res, `api /calc/sbm/bucket-cross-detail ${res.status}`);
  }
  return (await res.json()) as BucketCrossDetailResponse;
}

// Wave 5.96B — Total SBM orchestrator client. Fans out the 27-cell
// (class × leg × scenario) matrix server-side and returns the §21.4(8)
// max-over-scenarios risk charge plus per-cell evidence and parallelism
// metrics for the "Redis-fast" badge.
export interface TotalSbmRequest {
  bucket_subset?: string[];
  exclude?: { book?: string[]; trade_id?: string[]; risk_factor?: string[] };
  // Wave 6.41.C — same positive-include predicate as CalcSbmRequest.include,
  // passed straight through to every inner /calc/sbm cell on the api side.
  include?: {
    book?: string[];
    trade_id?: string[];
    desk?: string[];
    region?: string[];
    bucket?: number[];
  };
}
export type TotalSbmLeg = "delta" | "vega" | "curvature";
export interface TotalSbmScenarioCell {
  charge: number;
  ms: number;
  // Wave 5.96F — cold-compute cost preserved from the cached inner body
  // (when this cell was served from a /calc/sbm cache hit). Present on
  // every non-skipped cell since misses set it equal to the fresh cell_ms.
  original_compute_ms?: number;
  // Wave 5.96G-api — per-cell ingestion status. "populated" = real result;
  // "empty" = buckets discovered but no rows for this sensitivity_type;
  // "skipped" = whole class has no buckets at all (503 no-data-or-index).
  // Optional for forward-compat with pre-5.96G-api responses.
  data_status?: "populated" | "empty" | "skipped";
}
export interface TotalSbmBreakdownRow {
  risk_class: string;
  leg: TotalSbmLeg;
  skipped: boolean;
  scenarios: Record<CorrelationRegime, TotalSbmScenarioCell>;
}
export interface TotalSbmPerformance {
  total_ms: number;
  cumulative_ms: number;
  parallelism_factor: number;
  redis_ops_count: number;
  ops_skipped: number;
  // Wave 5.96F — sum of inner cold-compute costs (preserved through cache
  // hits). `cumulative_ms` is now the sum of freshly-measured cell_ms;
  // `original_cumulative_ms` retains the cold reference. `cache` is
  // populated when any cell participated in caching: "hit" = all cells were
  // cache hits, "miss" = none, "partial" = mixed.
  original_cumulative_ms?: number;
  // Wave 5.96N — companion to `parallelism_factor` sourced from the
  // preserved cold cumulative. On cache hits this is the true
  // cold-vs-warm speedup (`original_cumulative_ms / total_ms`); on cold
  // runs it equals `parallelism_factor`.
  original_parallelism_factor?: number;
  cache?: "hit" | "miss" | "partial";
  cache_hits?: number;
  // Wave 5.96G-api — count of cells where every bucket scanned zero rows
  // (data_status === "empty"). Skipped (503 no-data-or-index) cells are
  // NOT counted here — those are tracked via `ops_skipped`.
  cells_empty?: number;
}
export interface TotalSbmResponse {
  total_sbm: number;
  winning_scenario: CorrelationRegime;
  scenario_totals: Record<CorrelationRegime, number>;
  breakdown: TotalSbmBreakdownRow[];
  unsupported_classes: string[];
  performance: TotalSbmPerformance;
  resolved_command_summary: string;
}
export async function postCalcSbmTotal(body: TotalSbmRequest): Promise<TotalSbmResponse> {
  const res = await fetch(`${apiBase()}/calc/sbm/total`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await buildApiError(res, `api /calc/sbm/total ${res.status}`);
  }
  return (await res.json()) as TotalSbmResponse;
}

// Wave 6.41.D — top-N desks ranked by |contribution to K_b|, via the
// single-FT.AGGREGATE GROUPBY @desk path on the api. The per-desk K_b is a
// constant-ρ closed-form approximation (see services/api/src/sbm/by-desk.ts);
// suitable for ranking, not for reporting the Basel-correct desk-level charge.
export interface CalcSbmByDeskRequest {
  risk_class: string;
  sensitivity_type: SensitivityType;
  correlation_regime?: CorrelationRegime;
  top_n?: number;
  include?: { book?: string[]; desk?: string[] };
  exclude?: { book?: string[]; trade_id?: string[]; risk_factor?: string[] };
}
export interface CalcSbmByDeskRow {
  desk: string;
  K_b: number;
  contribution_pct: number;
  count: number;
}
export interface CalcSbmByDeskResponse {
  ok: true;
  ms: number;
  desks: CalcSbmByDeskRow[];
  total_K_b: number;
  cached: boolean;
}
export async function postCalcSbmByDesk(
  body: CalcSbmByDeskRequest,
): Promise<CalcSbmByDeskResponse> {
  const res = await fetch(`${apiBase()}/calc/sbm/by-desk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await buildApiError(res, `api /calc/sbm/by-desk ${res.status}`);
  }
  return (await res.json()) as CalcSbmByDeskResponse;
}
