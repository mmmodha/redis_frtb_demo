import { useCallback, useEffect, useRef, useState } from "react";
import { getObservabilityMemory } from "../lib/api";
import { fetchLiveDbKeyCount, getIndexCount } from "../lib/ingest";
import {
  formatBytesCompact,
  memoryBarLevel,
  memoryUsagePct,
  resolveMemoryCapBytes,
  type MemoryBarLevel,
} from "../lib/ingestMemoryDisplay";
import { pickSensDisplay, type SensDisplayState } from "../lib/ingestSensDisplay";

/** Idle cadence — matches server-side index-count cache window. */
export const INGEST_CLUSTER_IDLE_REFRESH_MS = 60_000;
/** Live cadence while a run is active (100k runs can finish in ~1s). */
export const INGEST_CLUSTER_ACTIVE_REFRESH_MS = 1_000;
/** Keep polling live DBSIZE after a run ends so flush lag does not stick the tile. */
export const INGEST_CLUSTER_BURST_MS = 60_000;

export interface UseIngestClusterStatsOpts {
  /** Poll uncached DBSIZE every ~1s while starting, running, or in the summary toast. */
  liveKeys?: boolean;
  /** Baseline from global ingest run context — survives navigation away from /ingest. */
  persistedKeysAtRunStart?: number | null;
}

export interface IngestMemoryView {
  usedBytes: number;
  usedHuman: string;
  capBytes: number | null;
  capHuman: string | null;
  pct: number | null;
  level: MemoryBarLevel;
}

const EMPTY_MEMORY: IngestMemoryView = {
  usedBytes: 0,
  usedHuman: "—",
  capBytes: null,
  capHuman: null,
  pct: null,
  level: "unknown",
};

export interface UseIngestClusterStatsResult {
  memory: IngestMemoryView;
  sens: SensDisplayState;
  keysAtRunStart: number | null;
  reloadAll: () => void;
  captureKeysBaseline: () => Promise<number>;
  clearKeysBaseline: () => void;
}

function memoryViewFromApi(mem: Awaited<ReturnType<typeof getObservabilityMemory>>): IngestMemoryView {
  const usedBytes = Number(mem.used_memory ?? 0);
  const usedHuman = typeof mem.used_memory_human === "string" ? mem.used_memory_human : "—";
  const capBytes = resolveMemoryCapBytes(mem);
  const capHuman = capBytes != null ? formatBytesCompact(capBytes) : null;
  const pct = memoryUsagePct(usedBytes, capBytes);
  return {
    usedBytes,
    usedHuman,
    capBytes,
    capHuman,
    pct,
    level: memoryBarLevel(pct),
  };
}

export function useIngestClusterStats(opts?: UseIngestClusterStatsOpts): UseIngestClusterStatsResult {
  const liveKeys = opts?.liveKeys === true;
  const persistedBaseline = opts?.persistedKeysAtRunStart ?? null;
  const [memory, setMemory] = useState<IngestMemoryView>(EMPTY_MEMORY);
  const [sens, setSens] = useState<SensDisplayState>({ count: 0 });
  const [localKeysAtRunStart, setLocalKeysAtRunStart] = useState<number | null>(null);
  const keysAtRunStart = persistedBaseline ?? localKeysAtRunStart;
  const [burstUntil, setBurstUntil] = useState(0);
  const sensRef = useRef<SensDisplayState>({ count: 0 });
  const prevLiveKeysRef = useRef(false);

  const livePolling = liveKeys || burstUntil > Date.now() || persistedBaseline != null;

  const applyKeyCount = useCallback((count: number, refreshing: boolean) => {
    const next = pickSensDisplay(sensRef.current, { count, refreshing });
    sensRef.current = next;
    setSens(next);
  }, []);

  const loadMemory = useCallback(async () => {
    try {
      const mem = await getObservabilityMemory();
      setMemory(memoryViewFromApi(mem));
    } catch {
      setMemory(EMPTY_MEMORY);
    }
  }, []);

  const refreshSensLive = useCallback(async () => {
    try {
      const count = await fetchLiveDbKeyCount();
      applyKeyCount(count, false);
    } catch {
      /* keep last stable value */
    }
  }, [applyKeyCount]);

  const refreshSensCached = useCallback(async () => {
    try {
      const ic = await getIndexCount();
      applyKeyCount(ic.count, ic.refreshing === true);
    } catch {
      /* keep last stable value */
    }
  }, [applyKeyCount]);

  const reloadAll = useCallback(() => {
    void loadMemory();
    void refreshSensLive();
  }, [loadMemory, refreshSensLive]);

  const captureKeysBaseline = useCallback(async (): Promise<number> => {
    try {
      const count = await fetchLiveDbKeyCount();
      setLocalKeysAtRunStart(count);
      return count;
    } catch {
      const fallback = sensRef.current.count;
      setLocalKeysAtRunStart(fallback);
      return fallback;
    }
  }, []);

  const clearKeysBaseline = useCallback(() => {
    setLocalKeysAtRunStart(null);
  }, []);

  useEffect(() => {
    if (prevLiveKeysRef.current && !liveKeys) {
      setBurstUntil(Date.now() + INGEST_CLUSTER_BURST_MS);
    }
    prevLiveKeysRef.current = liveKeys;
  }, [liveKeys]);

  useEffect(() => {
    if (burstUntil <= Date.now()) return undefined;
    const delay = burstUntil - Date.now();
    const id = window.setTimeout(() => setBurstUntil(0), delay);
    return () => window.clearTimeout(id);
  }, [burstUntil]);

  useEffect(() => {
    const tick = (): void => {
      void loadMemory();
      if (livePolling) {
        void refreshSensLive();
      } else {
        void refreshSensCached();
      }
    };

    tick();
    const intervalMs = livePolling ? INGEST_CLUSTER_ACTIVE_REFRESH_MS : INGEST_CLUSTER_IDLE_REFRESH_MS;
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [livePolling, loadMemory, refreshSensLive, refreshSensCached]);

  return {
    memory,
    sens,
    keysAtRunStart,
    reloadAll,
    captureKeysBaseline,
    clearKeysBaseline,
  };
}
