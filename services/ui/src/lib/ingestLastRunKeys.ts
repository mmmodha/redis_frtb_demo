export const INGEST_LAST_RUN_KEYS_STORAGE_KEY = "frtb:ingest-last-run-keys-added";

export interface IngestLastRunKeysAdded {
  run_id: string;
  keys_added: number;
  completed_at: number;
}

export function readLastRunKeysAdded(): IngestLastRunKeysAdded | null {
  try {
    const raw = localStorage.getItem(INGEST_LAST_RUN_KEYS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IngestLastRunKeysAdded>;
    if (typeof parsed?.run_id !== "string") return null;
    if (typeof parsed.keys_added !== "number" || !Number.isFinite(parsed.keys_added)) return null;
    return {
      run_id: parsed.run_id,
      keys_added: Math.max(0, Math.round(parsed.keys_added)),
      completed_at: typeof parsed.completed_at === "number" ? parsed.completed_at : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeLastRunKeysAdded(entry: IngestLastRunKeysAdded): void {
  try {
    localStorage.setItem(INGEST_LAST_RUN_KEYS_STORAGE_KEY, JSON.stringify({
      run_id: entry.run_id,
      keys_added: Math.max(0, Math.round(entry.keys_added)),
      completed_at: entry.completed_at,
    }));
  } catch { /* noop */ }
}

export function clearLastRunKeysAdded(): void {
  try {
    localStorage.removeItem(INGEST_LAST_RUN_KEYS_STORAGE_KEY);
  } catch { /* noop */ }
}

export function keysAddedFromBaseline(
  currentCount: number,
  baseline: number | null | undefined,
): number | null {
  if (baseline == null || !Number.isFinite(baseline)) return null;
  if (!Number.isFinite(currentCount)) return null;
  return Math.max(0, currentCount - baseline);
}
