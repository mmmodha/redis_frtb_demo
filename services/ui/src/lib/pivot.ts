// Wave 5.18: shared types + tiny fetcher for the existing GET /pivot endpoint.
// Drill-down inside CalcPanel reuses /pivot filtered by risk_class+bucket+
// sensitivity_type. PivotPanel keeps its existing inline fetch (its error
// rendering shape is asserted by tests with specific text) and only consumes
// the types from here — single source of truth for the PivotDoc shape.

import { apiBase } from "./api";
import { buildApiError } from "./empty-target";

// Sensitivity document body. Fields differ across risk classes / types
// (post-Wave 5.17a reshape — risk_value containers are objects, not arrays):
//   GIRR Delta|Vega: risk_value is { "3M": n, "6M": n, ..., "30Y": n }
//                    (tenor-keyed object; legacy number[] still accepted when
//                    the generator falls back to its no-tenor-metadata path).
//   GIRR Curvature:  risk_value is { cvr_up: number[]; cvr_down: number[] }.
//   Equity|FX Delta|Vega: risk_value is { spot: number } or scalar number.
//   Equity|FX Curvature:  risk_value is { cvr_up: number; cvr_down: number }.
// Treat everything optional; consumers branch on shape.
// Wave 6.47.B — `weight` may arrive as either a scalar (Equity / FX / FX-
// constant-table classes) or a tenor-keyed object (`{ "3M": w, "6M": w, ... }`
// for GIRR / other `by_tenor` classes). The /pivot route enriches each row
// from `schema.risk_weights[<ref>]`, which is itself a discriminated union;
// the union is widened to `unknown` here so consumers can branch on shape
// (see DrilldownValueCell + the BucketDrilldown weight `<td>` for the two
// concrete render branches).
export interface PivotDoc {
  trade_id?: string;
  risk_class?: string;
  bucket?: string;
  sensitivity_type?: string;
  risk_factor?: string;
  book?: string;
  weight?: number | Record<string, number> | unknown;
  risk_value?: unknown;
  [k: string]: unknown;
}

export interface PivotRow {
  key: string;
  doc: PivotDoc;
}

export interface PivotResp {
  rows: PivotRow[];
  total: number;
  limit: number;
  offset: number;
  ms: number;
}

export interface FetchPivotArgs {
  risk_class?: string;
  bucket?: string;
  sensitivity_type?: string;
  book?: string;
  trade_id?: string;
  limit?: number;
  offset?: number;
}

export async function fetchPivot(args: FetchPivotArgs): Promise<PivotResp> {
  const p = new URLSearchParams();
  if (args.risk_class) p.set("risk_class", args.risk_class);
  if (args.bucket) p.set("bucket", args.bucket);
  if (args.sensitivity_type) p.set("sensitivity_type", args.sensitivity_type);
  if (args.book) p.set("book", args.book);
  if (args.trade_id) p.set("trade_id", args.trade_id);
  if (args.limit !== undefined) p.set("limit", String(args.limit));
  if (args.offset !== undefined) p.set("offset", String(args.offset));
  const url = `${apiBase().replace(/\/$/, "")}/pivot?${p.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw await buildApiError(res, `api /pivot ${res.status}`);
  }
  return (await res.json()) as PivotResp;
}
