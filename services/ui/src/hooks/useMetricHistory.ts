// Wave 5.57 — per-metric history hook. Primary source is the api's
// /observability/history (RedisTimeSeries). When the active target lacks
// the TS module we fall back to a client-side ring buffer persisted in
// localStorage so a tab reload keeps recent history.
//
// Wave 6.44.B audit — already target-scoped: storageKey() composes
// `obs.ring.{target_label}.{metric}` so each target keeps its own ring.

import { useEffect, useRef, useState } from "react";
import { getObservabilityHistory, type ObservabilityHistoryPoint } from "../lib/api";

export type MetricName =
  | "total_keys"
  | "memory_used_bytes"
  | "ops_per_sec"
  | "shard_count";

export type HistorySource = "redis-timeseries" | "ring-buffer" | "unknown";
export type HistoryReason =
  | null
  | "module-not-loaded"
  | "no-data-yet"
  | "fetch-error";

export interface MetricHistoryState {
  source: HistorySource;
  points: ObservabilityHistoryPoint[];
  reason: HistoryReason;
  target_label: string | null;
  windowMs: number;
}

export const RETENTION_MS = 18_000_000; // 5h, mirrors the api default
export const RING_CAP = 1800;
const TS_REFRESH_MS = 30_000;
const STORAGE_PREFIX = "obs.ring.";

function storageKey(target_label: string, metric: MetricName): string {
  return `${STORAGE_PREFIX}${target_label}.${metric}`;
}

// We deliberately route through `window.localStorage` instead of the bare
// `localStorage` global. On Node 25+ a process-level localStorage exists and
// would shadow jsdom's window-scoped store in the test environment, which
// breaks both reads and writes inside the hook.
function ls(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

function readRing(target_label: string, metric: MetricName): ObservabilityHistoryPoint[] {
  const s = ls(); if (!s) return [];
  try {
    const raw = s.getItem(storageKey(target_label, metric));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ObservabilityHistoryPoint[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object") {
        const t = Number((entry as { t?: unknown }).t);
        const v = Number((entry as { v?: unknown }).v);
        if (Number.isFinite(t) && Number.isFinite(v)) out.push({ t, v });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeRing(
  target_label: string,
  metric: MetricName,
  points: ObservabilityHistoryPoint[],
): void {
  const s = ls(); if (!s) return;
  try {
    s.setItem(storageKey(target_label, metric), JSON.stringify(points));
  } catch {
    // quota errors are non-fatal; in-memory state is the source of truth
  }
}

export function purgeRing(target_label: string, metric: MetricName): void {
  const s = ls(); if (!s) return;
  try {
    s.removeItem(storageKey(target_label, metric));
  } catch {
    // ignore
  }
}

export interface UseMetricHistoryArgs {
  metric: MetricName;
  currentValue: number | null;
  pulseKey: number;
  enabled?: boolean;
  windowMs?: number;
  // Test seam — allows the test suite to assert on a fixed timestamp without
  // mocking Date. Production passes `undefined` and the hook calls Date.now().
  nowFn?: () => number;
}

export function useMetricHistory(args: UseMetricHistoryArgs): MetricHistoryState {
  const { metric, currentValue, pulseKey, enabled = true } = args;
  const windowMs = args.windowMs ?? RETENTION_MS;
  const now = args.nowFn ?? Date.now;

  const [state, setState] = useState<MetricHistoryState>({
    source: "unknown",
    points: [],
    reason: null,
    target_label: null,
    windowMs,
  });
  // `null` means "no pulse observed yet". The first render after the source
  // resolves seeds this with the parent's current pulseKey *without* pushing
  // a sample — we only want to capture transitions from one poll to the next.
  const lastPulseRef = useRef<number | null>(null);
  const lastTargetRef = useRef<string | null>(null);

  // Initial + periodic fetch from the api.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchOnce = async (): Promise<void> => {
      try {
        const res = await getObservabilityHistory(metric, windowMs);
        if (cancelled) return;
        // Target switch detected — purge the previous target's ring buffer
        // for this metric so stale samples don't leak across profiles.
        if (lastTargetRef.current && lastTargetRef.current !== res.target_label) {
          purgeRing(lastTargetRef.current, metric);
        }
        lastTargetRef.current = res.target_label;
        if (res.source === "redis-timeseries") {
          setState({
            source: "redis-timeseries",
            points: res.points,
            reason: res.reason,
            target_label: res.target_label,
            windowMs,
          });
        } else {
          // Wave 5.61 — clamp persisted ring buffer to the requested view
          // window. The storage itself is sized at RETENTION_MS so a
          // shrunken modal selection doesn't destroy older samples.
          const ring = readRing(res.target_label, metric);
          const viewCutoff = now() - windowMs;
          const view = windowMs >= RETENTION_MS ? ring : ring.filter((p) => p.t >= viewCutoff);
          setState({
            source: "ring-buffer",
            points: view,
            reason: res.reason ?? "module-not-loaded",
            target_label: res.target_label,
            windowMs,
          });
        }
      } catch {
        if (cancelled) return;
        // Network/api failure — surface as unknown with fetch-error so the
        // tile renders empty rather than spinning. The next poll retries.
        setState((prev) => ({
          source: prev.source === "unknown" ? "unknown" : prev.source,
          points: prev.points,
          reason: "fetch-error",
          target_label: prev.target_label,
          windowMs,
        }));
      }
    };
    void fetchOnce();
    const id = setInterval(() => { void fetchOnce(); }, TS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [metric, windowMs, enabled]);

  // Ring-buffer append on parent's pulseKey changes. Only runs when we're in
  // the fallback path — TS path keeps its samples server-side.
  useEffect(() => {
    if (!enabled) return;
    if (state.source !== "ring-buffer") return;
    if (state.target_label === null) return;
    if (currentValue === null || !Number.isFinite(currentValue)) return;
    if (pulseKey === lastPulseRef.current) return;
    if (lastPulseRef.current === null) {
      // First observation — seed without pushing so we don't conflate the
      // tile's initial value with a real polling tick.
      lastPulseRef.current = pulseKey;
      return;
    }
    lastPulseRef.current = pulseKey;
    setState((prev) => {
      if (prev.source !== "ring-buffer" || prev.target_label === null) return prev;
      if (windowMs >= RETENTION_MS) {
        // Default path — unchanged from Wave 5.57.
        const cutoff = now() - windowMs;
        const next = [...prev.points, { t: now(), v: currentValue }]
          .filter((p) => p.t >= cutoff)
          .slice(-RING_CAP);
        writeRing(prev.target_label, metric, next);
        return { ...prev, points: next, reason: next.length > 0 ? null : "no-data-yet" };
      }
      // Wave 5.61 — modal-zoom path. The visible `points` are clamped to
      // the smaller window, but the persisted ring is sized at
      // RETENTION_MS so closing/reopening the modal doesn't lose history.
      const storeCutoff = now() - RETENTION_MS;
      const viewCutoff = now() - windowMs;
      const stored = readRing(prev.target_label, metric);
      const full = [...stored, { t: now(), v: currentValue }]
        .filter((p) => p.t >= storeCutoff)
        .slice(-RING_CAP);
      writeRing(prev.target_label, metric, full);
      const view = full.filter((p) => p.t >= viewCutoff);
      return { ...prev, points: view, reason: view.length > 0 ? null : "no-data-yet" };
    });
  }, [pulseKey, currentValue, enabled, state.source, state.target_label, metric, windowMs, now]);

  return state;
}
