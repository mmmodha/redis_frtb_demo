// Wave 6.39.C — Layer 4: rollup drift detector.
//
// Picks one random (rc, bucket) per tick from the materialized discovery sets
// (`seen:risk_class`, `seen:bucket:{<rc>}`) and compares the persisted
// `rollup:{<rc>:<bkt>}:<sens>` hash's `sum_ws` against a fresh recomputation.
// Recomputation is injected so the worker stays decoupled from the schema-
// dependent FT.AGGREGATE path (callers wire `aggregateBucketsViaIndex` here;
// tests stub a fixture sum). Results land in a bounded ring buffer
// (last 100, oldest evicted first) read by GET /admin/drift-status.

import type { RedisLike } from "../redis-like.ts";
import { rollupKey, SEEN_RISK_CLASS_KEY, seenBucketKey } from "@frtb/calc-shared/rollup-keys";
import { incCounter } from "./metrics.ts";

export type DriftSensitivity = "Delta" | "Vega" | "Curvature";
export type DriftStatus = "ok" | "drift";

export interface DriftResult {
  ts: string;
  bucket: string;
  risk_class: string;
  sensitivity_type: DriftSensitivity;
  rollup_sum: number;
  recomputed_sum: number;
  drift_pct: number;
  status: DriftStatus;
}

export interface DriftLogger {
  error: (obj: Record<string, unknown>) => void;
}

export interface RunDriftCheckOpts {
  redis: RedisLike;
  sensitivityType: DriftSensitivity;
  // Drift threshold expressed as a percentage of |rollup_sum| (default 0.01).
  thresholdPct?: number;
  // Injectable recompute. Production wires this to a thin wrapper around
  // `aggregateBucketsViaIndex` so the drift detector stays decoupled from
  // the schema-specific FT.AGGREGATE shape; tests pass a fixture value.
  recomputeSum: (rc: string, bucket: string, sens: DriftSensitivity) => Promise<number>;
  log?: DriftLogger;
}

const MAX_RESULTS = 100;
const results: DriftResult[] = [];

function pushResult(r: DriftResult): void {
  results.push(r);
  if (results.length > MAX_RESULTS) results.shift();
}

export function getDriftResults(): DriftResult[] {
  return results.slice();
}

export function __resetDriftResultsForTests(): void {
  results.length = 0;
}

// Parse a RESP2 flat key/value HGETALL reply OR a RESP3 map. Returns null
// for empty/missing hashes so the caller can skip silently rather than
// recording a false-positive drift.
function parseHgetall(reply: unknown): Record<string, string> | null {
  if (reply === null || reply === undefined) return null;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < reply.length; i += 2) {
      out[String(reply[i])] = String(reply[i + 1]);
    }
    return out;
  }
  if (typeof reply === "object") {
    const src = reply as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) out[k] = String(v);
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

export async function runDriftCheck(opts: RunDriftCheckOpts): Promise<DriftResult | null> {
  const { redis, sensitivityType, recomputeSum, log } = opts;
  const threshold = opts.thresholdPct ?? 0.01;
  // Always count the tick — even an empty seen-set tick is a meaningful
  // "did the detector run" signal for /metrics + alerting.
  incCounter("drift_check_total");
  const rcRaw = await redis.call("SRANDMEMBER", SEEN_RISK_CLASS_KEY);
  if (rcRaw === null || rcRaw === undefined || rcRaw === "") return null;
  const rc = String(rcRaw);
  const bktRaw = await redis.call("SRANDMEMBER", seenBucketKey(rc));
  if (bktRaw === null || bktRaw === undefined || bktRaw === "") return null;
  const bucket = String(bktRaw);

  const key = rollupKey(rc, bucket, sensitivityType);
  const hgetall = parseHgetall(await redis.call("HGETALL", key));
  const rollupSum = Number(hgetall?.sum_ws ?? 0);
  const recomputedSum = await recomputeSum(rc, bucket, sensitivityType);

  // `drift_pct` is reported in percent (consistent with the spec default
  // "0.01%"). `thresholdPct` therefore compares to the same units; a 1.5%
  // deviation surfaces as `drift_pct: 1.5` against `thresholdPct: 0.01`.
  const denom = Math.abs(rollupSum);
  const diffPct = denom > 0
    ? (Math.abs(rollupSum - recomputedSum) / denom) * 100
    : (recomputedSum === 0 ? 0 : Infinity);
  const status: DriftStatus = diffPct > threshold ? "drift" : "ok";
  const result: DriftResult = {
    ts: new Date().toISOString(),
    bucket: `${rc}:${bucket}`,
    risk_class: rc,
    sensitivity_type: sensitivityType,
    rollup_sum: rollupSum,
    recomputed_sum: recomputedSum,
    drift_pct: diffPct,
    status,
  };
  pushResult(result);
  if (status === "drift") {
    log?.error?.({
      event: "rollup_drift_detected",
      bucket: result.bucket,
      sensitivity_type: sensitivityType,
      rollup_sum: rollupSum,
      recomputed_sum: recomputedSum,
      drift_pct: diffPct,
      threshold_pct: threshold,
    });
  }
  return result;
}

export interface StartDriftCronOpts extends RunDriftCheckOpts {
  intervalMs: number;
}

// Minimal interval scheduler. Returns a stop function so callers can clean
// up in tests / on graceful shutdown. Each tick runs runDriftCheck and
// swallows errors — a single transient FT.AGGREGATE failure must not crash
// the api process.
export function startDriftDetectorCron(opts: StartDriftCronOpts): () => void {
  const tick = async (): Promise<void> => {
    try {
      await runDriftCheck(opts);
    } catch (err) {
      opts.log?.error?.({ event: "drift_detector_tick_failed", err: String(err) });
    }
  };
  const handle = setInterval(() => { void tick(); }, opts.intervalMs);
  return () => clearInterval(handle);
}
