// Wave 5.57 — RedisTimeSeries detection + write/read helpers.
//
// Powers /observability/history. Detection runs MODULE LIST and caches the
// result per (target_label, 60s TTL); a target switch flips the cache key
// and re-detects on the next call. Writes are best-effort: every error is
// swallowed so a failed TS.ADD cannot break the underlying /observability
// snapshot endpoint. Reads aggregate to avg over max ~300 buckets so the
// chart never has to render more than that.

import type { RedisLike } from "../redis-like.ts";

export type MetricName =
  | "total_keys"
  | "memory_used_bytes"
  | "ops_per_sec"
  | "shard_count";

const METRIC_KEYS: Record<MetricName, string> = {
  total_keys: "obs:metrics:total_keys",
  memory_used_bytes: "obs:metrics:memory_used_bytes",
  ops_per_sec: "obs:metrics:ops_per_sec",
  shard_count: "obs:metrics:shard_count",
};

export const RETENTION_MS = 18_000_000; // 5h
const DETECTION_TTL_MS = 60_000;

interface DetectionCache {
  target_label: string;
  available: boolean;
  lastChecked: number;
}
let detectionCache: DetectionCache | null = null;

const ensuredKeys = new Set<string>();
let ensuredTarget = "";

export function resetTimeSeriesCacheForTests(): void {
  detectionCache = null;
  ensuredKeys.clear();
  ensuredTarget = "";
}

export function isValidMetric(s: string): s is MetricName {
  return Object.prototype.hasOwnProperty.call(METRIC_KEYS, s);
}

export function getMetricKey(metric: MetricName): string {
  return METRIC_KEYS[metric];
}

// MODULE LIST replies as an array of arrays of [field, value, field, value, ...]
// pairs. We look for a "name" field whose value equals "timeseries" (case-
// insensitive). Some clients also surface the module name as a bare string in
// the entry — accept that shape too as a fallback.
function entryIsTimeseries(entry: unknown): boolean {
  if (!Array.isArray(entry)) return false;
  for (let i = 0; i + 1 < entry.length; i += 2) {
    const k = entry[i];
    const v = entry[i + 1];
    if (typeof k === "string" && k.toLowerCase() === "name") {
      if (typeof v === "string" && v.toLowerCase() === "timeseries") return true;
    }
  }
  for (const el of entry) {
    if (typeof el === "string" && el.toLowerCase() === "timeseries") return true;
  }
  return false;
}

export async function detectTimeSeries(
  redis: RedisLike,
  target_label: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (
    detectionCache &&
    detectionCache.target_label === target_label &&
    now - detectionCache.lastChecked < DETECTION_TTL_MS
  ) {
    return detectionCache.available;
  }
  let available = false;
  try {
    const raw = await redis.call("MODULE", "LIST");
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entryIsTimeseries(entry)) { available = true; break; }
      }
    }
  } catch {
    available = false;
  }
  detectionCache = { target_label, available, lastChecked: now };
  if (ensuredTarget !== target_label) {
    ensuredKeys.clear();
    ensuredTarget = target_label;
  }
  return available;
}

async function ensureKey(
  redis: RedisLike,
  metric: MetricName,
  target_label: string,
): Promise<void> {
  if (ensuredTarget !== target_label) {
    ensuredKeys.clear();
    ensuredTarget = target_label;
  }
  const key = METRIC_KEYS[metric];
  if (ensuredKeys.has(key)) return;
  try {
    await redis.call(
      "TS.CREATE", key,
      "RETENTION", String(RETENTION_MS),
      "DUPLICATE_POLICY", "LAST",
      "LABELS",
      "metric", metric,
      "source", "frtb-api",
    );
  } catch {
    // Swallow — `already exists` is the expected steady-state path; any
    // other error means TS.ADD below will also fail and be swallowed.
  }
  ensuredKeys.add(key);
}

// Fire-and-forget. Never throws — caller can `void writeMetric(...)` from a
// hot snapshot endpoint without worrying about unhandled rejections.
export async function writeMetric(
  redis: RedisLike,
  metric: MetricName,
  value: number,
  target_label: string,
): Promise<void> {
  try {
    if (!Number.isFinite(value)) return;
    const available = await detectTimeSeries(redis, target_label);
    if (!available) return;
    await ensureKey(redis, metric, target_label);
    await redis.call("TS.ADD", METRIC_KEYS[metric], "*", String(value));
  } catch {
    // swallow — the write path is best-effort
  }
}

export interface HistoryPoint { t: number; v: number }
export interface HistoryResult {
  source: "redis-timeseries" | "unavailable";
  points: HistoryPoint[];
  reason: null | "module-not-loaded" | "no-data-yet";
}

export async function readHistory(
  redis: RedisLike,
  metric: MetricName,
  windowMs: number,
  target_label: string,
  now: number = Date.now(),
): Promise<HistoryResult> {
  const available = await detectTimeSeries(redis, target_label, now);
  if (!available) {
    return { source: "unavailable", points: [], reason: "module-not-loaded" };
  }
  const fromMs = now - windowMs;
  const bucketMs = Math.max(1000, Math.floor(windowMs / 300));
  const key = METRIC_KEYS[metric];
  let raw: unknown;
  try {
    raw = await redis.call(
      "TS.RANGE", key, String(fromMs), "+",
      "AGGREGATION", "avg", String(bucketMs),
    );
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    if (msg.includes("does not exist") || msg.includes("tsdb")) {
      return { source: "redis-timeseries", points: [], reason: "no-data-yet" };
    }
    return { source: "redis-timeseries", points: [], reason: "no-data-yet" };
  }
  const points: HistoryPoint[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const t = Number(entry[0]);
        const v = Number(entry[1]);
        if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
      }
    }
  }
  if (points.length === 0) {
    return { source: "redis-timeseries", points: [], reason: "no-data-yet" };
  }
  return { source: "redis-timeseries", points, reason: null };
}
