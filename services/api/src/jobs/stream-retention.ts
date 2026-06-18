// Wave 6.39.C — Layer 4: ingest stream retention.
//
// Derives an approximate XADD MAXLEN cap (`computeMaxLen`) such that the
// ingest stream (`sensitivities:in`) survives at least 48 h of writes at
// the observed peak rate, scaled by a safety factor (default 2). The
// stream-retention surface keeps both the formula and the live snapshot
// in one place so /admin/stream-status and any future XTRIM helper share
// the same primitives.

import type { RedisLike } from "../redis-like.ts";

export const DEFAULT_RETENTION_HOURS = 48;
export const DEFAULT_SAFETY_FACTOR = 2;
export const DEFAULT_STREAM_KEY = "sensitivities:in";

export interface ComputeMaxLenOpts {
  retentionHours?: number;
  safetyFactor?: number;
}

// peakRatePerSec × 3600 × hours × safety. Returns a non-negative integer so
// MAXLEN args are RESP-safe. peakRatePerSec ≤ 0 collapses to 0 (no cap),
// matching the existing routes/generator opt-out semantics for MAXLEN=0.
export function computeMaxLen(peakRatePerSec: number, opts: ComputeMaxLenOpts = {}): number {
  const hours = opts.retentionHours ?? DEFAULT_RETENTION_HOURS;
  const safety = opts.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
  if (!Number.isFinite(peakRatePerSec) || peakRatePerSec <= 0) return 0;
  return Math.floor(peakRatePerSec * 3600 * hours * safety);
}

export interface StreamStatusOpts {
  streamKey: string;
  maxLen: number;
  peakRatePerSec: number;
}

export interface StreamStatus {
  stream_key: string;
  xlen: number;
  maxlen: number;
  peak_rate_per_sec: number;
  // hours of retention available right now at the configured peak rate
  // (`xlen / peak / 3600`). Used by the UI banner to flag a degraded stream
  // before it churns through the MAXLEN window.
  retention_hours_now: number;
  retention_hours_at_cap: number;
}

export async function readStreamStatus(
  redis: RedisLike,
  opts: StreamStatusOpts,
): Promise<StreamStatus> {
  let xlen = 0;
  try {
    const reply = await redis.call("XLEN", opts.streamKey);
    const n = Number(reply);
    xlen = Number.isFinite(n) ? n : 0;
  } catch {
    // Stream missing or unreachable — surface 0 rather than throw so the
    // /admin/stream-status endpoint stays informational on a fresh cluster.
    xlen = 0;
  }
  const peak = opts.peakRatePerSec;
  const retentionHoursNow = peak > 0 ? xlen / peak / 3600 : 0;
  const retentionHoursAtCap = peak > 0 ? opts.maxLen / peak / 3600 : 0;
  return {
    stream_key: opts.streamKey,
    xlen,
    maxlen: opts.maxLen,
    peak_rate_per_sec: peak,
    retention_hours_now: retentionHoursNow,
    retention_hours_at_cap: retentionHoursAtCap,
  };
}

// Measure the empirical ingest peak rate by sampling XLEN twice over a
// window. The result feeds computeMaxLen for the persisted MAXLEN value.
// Production wires this into a one-shot benchmark on boot (or via a manual
// admin trigger); tests exercise computeMaxLen + readStreamStatus directly.
export interface MeasurePeakOpts {
  redis: RedisLike;
  streamKey?: string;
  windowMs?: number;
}

export async function measurePeakRate(opts: MeasurePeakOpts): Promise<number> {
  const stream = opts.streamKey ?? DEFAULT_STREAM_KEY;
  const window = opts.windowMs ?? 60_000;
  const t0 = Date.now();
  const x0 = Number(await opts.redis.call("XLEN", stream).catch(() => 0));
  await new Promise((r) => setTimeout(r, window));
  const t1 = Date.now();
  const x1 = Number(await opts.redis.call("XLEN", stream).catch(() => 0));
  const elapsedSec = Math.max(0.001, (t1 - t0) / 1000);
  const delta = Math.max(0, x1 - x0);
  return delta / elapsedSec;
}
