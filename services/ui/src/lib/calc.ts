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

export interface BucketResult {
  bucket: string;
  K_b: number;
  S_b: number;
  count: number;
  ms: number;
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
