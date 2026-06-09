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
