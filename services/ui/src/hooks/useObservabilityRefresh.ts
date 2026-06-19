// Wave 5.51 — cadence state for the Observability page. Reads/writes
// localStorage["obs.refresh.ms"]; invalid or missing values fall back to the
// 2s default. Valid cadences are 0 (Off) / 1s / 2s / 5s / 10s in ms.
//
// Wave 6.44.B audit — intentionally global (not target-scoped). The poll
// cadence is an operator UI preference for the Observability page; the same
// human wants the same refresh rate against any active target.

import { useCallback, useEffect, useState } from "react";

export const OBS_REFRESH_STORAGE_KEY = "obs.refresh.ms";

export interface ObsRefreshOption {
  label: string;
  value: number;
}

export const OBS_REFRESH_OPTIONS: readonly ObsRefreshOption[] = [
  { label: "Off", value: 0 },
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
];

export const OBS_REFRESH_DEFAULT_MS = 2000;

const VALID_VALUES = new Set<number>(OBS_REFRESH_OPTIONS.map((o) => o.value));

function readStored(): number {
  if (typeof localStorage === "undefined") return OBS_REFRESH_DEFAULT_MS;
  try {
    const raw = localStorage.getItem(OBS_REFRESH_STORAGE_KEY);
    if (raw === null) return OBS_REFRESH_DEFAULT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && VALID_VALUES.has(n) ? n : OBS_REFRESH_DEFAULT_MS;
  } catch {
    return OBS_REFRESH_DEFAULT_MS;
  }
}

export interface UseObservabilityRefreshResult {
  cadenceMs: number;
  setCadenceMs: (ms: number) => void;
}

export function useObservabilityRefresh(): UseObservabilityRefreshResult {
  const [cadenceMs, setCadenceMsState] = useState<number>(() => readStored());

  // Persist on every change. Wrapped in try/catch — storage quota or privacy
  // mode shouldn't crash the page; we just lose the round-trip.
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(OBS_REFRESH_STORAGE_KEY, String(cadenceMs));
    } catch {
      // ignore
    }
  }, [cadenceMs]);

  const setCadenceMs = useCallback((ms: number) => {
    setCadenceMsState(VALID_VALUES.has(ms) ? ms : OBS_REFRESH_DEFAULT_MS);
  }, []);

  return { cadenceMs, setCadenceMs };
}
