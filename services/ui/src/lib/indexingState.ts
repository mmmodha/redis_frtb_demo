// Wave 6.41.E — localStorage-backed anchor for the IngestPanel "Indexing"
// progress bar.
//
// Wave 6.41.E.fix3 — data source switched from `xlen` to the strictly-
// monotonic `consumed` counter (`ingest:consumed:<stream>` published by
// services/ingest at 1Hz; surfaced through /admin/stream-status). Unbounded
// streams (stream_maxlen=0) never see xlen shrink, so the prior anchor-on-
// peak-xlen design pinned the bar at 0%. Pct math is now
// (consumedNow - consumedAtAnchor) / rowsTotal. Storage key bumped to v2;
// v1 anchors are silently dropped on read (acceptable per the task spec).
//
// Wave 6.44.B — anchor is now per-active-target. Storage key bumped to
// `frtb:indexing:anchor:v3:{target_label}` so switching targets mid-flow
// (Connections panel "Activate" on another cluster) shows the new target's
// own progress (or no bar) instead of mis-attributing the prior target's
// state. v2 entries are silently dropped on first read after upgrade —
// same precedent as v1→v2; no migration is written. The anchor body
// additionally carries `targetLabel` so the IngestPanel render guard can
// evict in-memory state that lags a live target switch by one render.
//
// Wave 6.44.D — data source switched from the ingest `consumed` counter to
// the live `FT.SEARCH * LIMIT 0 0` count against the active sens-index
// (surfaced through /admin/index-count). The consumed counter leads the
// index by the ingest write lag, which made the bar overshoot what a calc
// query could actually see. Field renamed `consumedAtAnchor` →
// `indexCountAtAnchor`; storage key bumped to v4. v3 entries are silently
// dropped on read (same precedent as v1→v2, v2→v3).
//
// Wave 6.52.A — data source switched to the ingest worker's `consumed`
// counter (/admin/stream-status). Field renamed `indexCountAtAnchor` →
// `consumedAtAnchor`; sample shape `ConsumedSample {consumed, ts}`;
// storage key bumped to `frtb:writing:anchor:v1:`.
//
// Wave 6.52.C — data source reverted back to the live FT.SEARCH count
// (/admin/index-count). The `consumed` counter is per-worker-process and
// in-memory (resets on restart) and the generator fans 1 logical row →
// ~2 stream entries, so it is an unreliable denominator. `index-count`
// is the ground truth for "sens queryable in Redis"; the anchor model
// already handles the "show only this run's increment" requirement
// correctly when paired with `index-count`. Field renamed
// `consumedAtAnchor` → `indexCountAtAnchor`; sample shape renamed
// `ConsumedSample {consumed, ts}` → `IndexCountSample {indexCount, ts}`.
// Storage key bumped to `frtb:indexing:anchor:v2:`; in-flight Wave 6.52.A
// entries at the v1 writing key are silently dropped on read.

export const STORAGE_KEY_PREFIX = "frtb:indexing:anchor:v2:";
export const ANCHOR_TTL_MS = 24 * 60 * 60 * 1000;

export function storageKeyFor(label: string): string {
  return STORAGE_KEY_PREFIX + label;
}

export interface IndexingAnchor {
  // The generator run that seeded this indexing pass. May be null when the
  // anchor was created from an implicit mount-time observation (xlen > 0
  // with no prior anchor — e.g. the page was opened after a run completed).
  runId: string | null;
  // Total rows the producer queued. The denominator for the bar: pct grows
  // toward 100% as `indexCountNow - indexCountAtAnchor` approaches rowsTotal.
  rowsTotal: number;
  // Wave 6.52.C — value of /admin/index-count (FT.SEARCH * LIMIT 0 0 against
  // the active sens-index) at the moment this anchor was created. The 0%
  // baseline. Pct math is (indexCountNow - indexCountAtAnchor) / rowsTotal.
  indexCountAtAnchor: number;
  // When this anchor was created. Used for TTL eviction.
  anchorTs: number;
  // Most recent time the anchor was touched (poll, refresh). Persisted so a
  // future iteration could use it for staleness heuristics; today it is
  // bumped on writes and read for diagnostics only.
  lastSeenAt: number;
  // Wave 6.44.B — active target label this anchor was created against.
  // Redundant with the storage-key suffix (anchors are already partitioned
  // by label in storage) but persisted on the body so the IngestPanel
  // render guard can detect a target switch even when the in-memory state
  // hasn't yet been re-read against the new label.
  targetLabel: string;
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readAnchor(label: string, now: number = Date.now()): IndexingAnchor | null {
  const store = getStorage();
  if (!store) return null;
  const key = storageKeyFor(label);
  let raw: string | null;
  try { raw = store.getItem(key); } catch { return null; }
  if (!raw) return null;
  let parsed: Partial<IndexingAnchor>;
  try { parsed = JSON.parse(raw) as Partial<IndexingAnchor>; }
  catch { return null; }
  if (
    typeof parsed.indexCountAtAnchor !== "number"
    || typeof parsed.anchorTs !== "number"
    || typeof parsed.rowsTotal !== "number"
    || typeof parsed.lastSeenAt !== "number"
  ) {
    return null;
  }
  if (now - parsed.anchorTs > ANCHOR_TTL_MS) {
    try { store.removeItem(key); } catch { /* noop */ }
    return null;
  }
  return {
    runId: typeof parsed.runId === "string" ? parsed.runId : null,
    rowsTotal: parsed.rowsTotal,
    indexCountAtAnchor: parsed.indexCountAtAnchor,
    anchorTs: parsed.anchorTs,
    lastSeenAt: parsed.lastSeenAt,
    targetLabel: typeof parsed.targetLabel === "string" ? parsed.targetLabel : label,
  };
}

export function writeAnchor(label: string, a: IndexingAnchor): void {
  const store = getStorage();
  if (!store) return;
  try { store.setItem(storageKeyFor(label), JSON.stringify(a)); } catch { /* quota */ }
}

export function clearAnchor(label: string): void {
  const store = getStorage();
  if (!store) return;
  try { store.removeItem(storageKeyFor(label)); } catch { /* noop */ }
}

// Clamp to [0, 100]. rowsTotal <= 0 ⇒ nothing to index ⇒ 100%. An
// indexCountNow below indexCountAtAnchor (FLUSHDB, index drop) clamps to
// 0% — callers detect that case separately and re-anchor.
export function computePct(
  indexCountAtAnchor: number,
  indexCountNow: number,
  rowsTotal: number,
): number {
  if (!Number.isFinite(rowsTotal) || rowsTotal <= 0) return 100;
  if (!Number.isFinite(indexCountAtAnchor) || !Number.isFinite(indexCountNow)) return 0;
  const indexed = indexCountNow - indexCountAtAnchor;
  if (indexed <= 0) return 0;
  if (indexed >= rowsTotal) return 100;
  return (indexed / rowsTotal) * 100;
}

// Wave 6.52.C — per-tick sample of /admin/index-count (FT.SEARCH * LIMIT
// 0 0). The bar reflects what a calc query can actually see in the index
// rather than the per-worker in-memory `consumed` counter.
export interface IndexCountSample { indexCount: number; ts: number }

// Sliding-window rate computation. Returns rows-per-sec indexed between the
// oldest and newest sample (positive when indexCount is growing). The
// index count is monotonic during a single ingest pass so the "negative
// drain" branch from the prior xlen-based design is unnecessary. Returns
// null when fewer than two samples or no time has elapsed.
export function computeRatePerSec(samples: IndexCountSample[]): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const elapsedMs = last.ts - first.ts;
  if (elapsedMs <= 0) return null;
  const indexed = last.indexCount - first.indexCount;
  if (indexed <= 0) return 0;
  return (indexed / elapsedMs) * 1000;
}

// Push a new sample into a bounded sliding window. Pure (returns a new
// array) so React state updates remain referentially honest.
export function pushSample(
  samples: IndexCountSample[],
  sample: IndexCountSample,
  windowSize = 10,
): IndexCountSample[] {
  const next = samples.concat([sample]);
  if (next.length > windowSize) next.splice(0, next.length - windowSize);
  return next;
}
