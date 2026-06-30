import type { RedisLike } from "../redis-like.ts";

const SENS_KEY_COUNT_REFRESH_MS = 60_000;
const INDEX_LABEL = "dbsize";

const sensKeyCountCache = new Map<string, { count: number; at: number }>();

export interface SensKeyCountSnapshot {
  count: number;
  refreshing: boolean;
  index_name: string | null;
}

export async function getSensKeyCountSnapshot(
  target_label: string,
  redis: RedisLike,
  opts?: { forceRefresh?: boolean },
): Promise<SensKeyCountSnapshot> {
  const now = Date.now();
  if (opts?.forceRefresh) sensKeyCountCache.delete(target_label);
  const cached = sensKeyCountCache.get(target_label);
  if (cached && now - cached.at < SENS_KEY_COUNT_REFRESH_MS) {
    return { count: cached.count, refreshing: false, index_name: INDEX_LABEL };
  }

  try {
    const raw = await redis.dbsize();
    const count = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    sensKeyCountCache.set(target_label, { count, at: now });
    return { count, refreshing: false, index_name: INDEX_LABEL };
  } catch {
    return {
      count: cached?.count ?? 0,
      refreshing: false,
      index_name: INDEX_LABEL,
    };
  }
}

export function setSensKeyCountSnapshot(target_label: string, count: number): void {
  sensKeyCountCache.set(target_label, { count, at: Date.now() });
}

/** Test seam — reset module state between tests. */
export function _testResetSensKeyCountCache(): void {
  sensKeyCountCache.clear();
}
