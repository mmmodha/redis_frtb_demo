// Typed client for the MVP `POST /calc/sbm` endpoint.
// Contract restated from spec ("Wave 2 contracts (locked)"):
//   request:  { risk_class, sensitivity_type }
//   response: { charge, per_bucket[], total_ms, shard_breakdown[], fanout_ms }

import { apiBase } from "./api";

export type SensitivityType = "Delta" | "Vega";

export interface CalcSbmRequest {
  risk_class: string;
  sensitivity_type: SensitivityType;
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
}

export interface CalcSbmResponse {
  charge: number;
  per_bucket: BucketResult[];
  total_ms: number;
  shard_breakdown: ShardBreakdownEntry[];
  fanout_ms: number;
  commands?: CalcCommands;
}

export async function postCalcSbm(body: CalcSbmRequest): Promise<CalcSbmResponse> {
  const res = await fetch(`${apiBase()}/calc/sbm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `api /calc/sbm ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) msg = parsed.error;
    } catch {
      /* non-json body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as CalcSbmResponse;
}
