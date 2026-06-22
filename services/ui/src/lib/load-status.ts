// Wave 7.0.6.21 — typed wrapper around the api proxy for the bulk-loader's
// GET /load/status, focused on the fields the RateGauge surface consumes.
// The wider /load/status payload (per-worker breakdowns, target identity,
// drain counters, …) stays owned by ./ingest.ts's getBulkLoadStatus; this
// module exists so the rate-gauge panel can read a small, well-typed view
// without pulling the kitchen-sink shape into its props.
//
// The api side already proxies /ingest/bulk/load-status → bulk-loader's
// /load/status verbatim, so we hit the same endpoint here. On any failure
// (network, 5xx, malformed json, bulk-loader down) we degrade to the
// "no backpressure visible" defaults so the gauge renders without a
// throttle chip rather than crashing the panel:
//   { in_flight: 0, high_water: 0, throttled: false, headroom_pct: 1,
//     recent_429_count: 0 }
import { apiBase } from "./api";

export interface LoadStatusSummary {
  in_flight: number;
  high_water: number;
  throttled: boolean;
  headroom_pct: number;
  recent_429_count: number;
}

export const LOAD_STATUS_GRACEFUL_DEFAULT: LoadStatusSummary = {
  in_flight: 0,
  high_water: 0,
  throttled: false,
  headroom_pct: 1,
  recent_429_count: 0,
};

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeLoadStatus(raw: unknown): LoadStatusSummary {
  if (!raw || typeof raw !== "object") return { ...LOAD_STATUS_GRACEFUL_DEFAULT };
  const obj = raw as Record<string, unknown>;
  const dispatcher = (obj.dispatcher && typeof obj.dispatcher === "object")
    ? (obj.dispatcher as Record<string, unknown>)
    : null;
  const in_flight = dispatcher ? pickNumber(dispatcher.in_flight, 0) : 0;
  const high_water = dispatcher ? pickNumber(dispatcher.high_water, 0) : 0;
  const headroom_pct = pickNumber(obj.headroom_pct, 1);
  const recent_429_count = Math.max(0, Math.trunc(pickNumber(obj.recent_429_count, 0)));
  const throttled = obj.throttled === true;
  return { in_flight, high_water, throttled, headroom_pct, recent_429_count };
}

export async function getLoadStatusSummary(): Promise<LoadStatusSummary> {
  try {
    const res = await fetch(`${apiBase()}/ingest/bulk/load-status`);
    if (!res.ok) return { ...LOAD_STATUS_GRACEFUL_DEFAULT };
    const body = (await res.json()) as unknown;
    return normalizeLoadStatus(body);
  } catch {
    return { ...LOAD_STATUS_GRACEFUL_DEFAULT };
  }
}
