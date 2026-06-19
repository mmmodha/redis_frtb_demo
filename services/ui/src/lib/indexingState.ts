// Wave 6.41.E — localStorage-backed anchor for the IngestPanel "Indexing"
// progress bar. The stream length (xlen) is the source of truth for
// "is indexing in progress"; this module persists the peak xlen we have
// observed for the most recent generator run so a tab reload / sleep can
// reconstruct % indexed without a server-side endpoint. Single-anchor
// design: a new anchor replaces the previous one.

export const STORAGE_KEY = "frtb:indexing:anchor:v1";
export const ANCHOR_TTL_MS = 24 * 60 * 60 * 1000;

export interface IndexingAnchor {
  // The generator run that seeded this indexing pass. May be null when the
  // anchor was created from an implicit mount-time observation (xlen > 0
  // with no prior anchor — e.g. the page was opened after a run completed).
  runId: string | null;
  // Total rows the producer queued. Mirrors anchorXlen when the anchor is
  // seeded from the post-terminal xlen; surfaced so the UI can show the
  // matching label as the generator bar.
  rowsTotal: number;
  // Peak xlen observed for this run; the 100% baseline. Pct math is
  // (anchorXlen - currentXlen) / anchorXlen.
  anchorXlen: number;
  // When this anchor was created. Used for TTL eviction.
  anchorTs: number;
  // Most recent time the anchor was touched (poll, refresh). Persisted so a
  // future iteration could use it for staleness heuristics; today it is
  // bumped on writes and read for diagnostics only.
  lastSeenAt: number;
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readAnchor(now: number = Date.now()): IndexingAnchor | null {
  const store = getStorage();
  if (!store) return null;
  let raw: string | null;
  try { raw = store.getItem(STORAGE_KEY); } catch { return null; }
  if (!raw) return null;
  let parsed: Partial<IndexingAnchor>;
  try { parsed = JSON.parse(raw) as Partial<IndexingAnchor>; }
  catch { return null; }
  if (
    typeof parsed.anchorXlen !== "number"
    || typeof parsed.anchorTs !== "number"
    || typeof parsed.rowsTotal !== "number"
    || typeof parsed.lastSeenAt !== "number"
  ) {
    return null;
  }
  if (now - parsed.anchorTs > ANCHOR_TTL_MS) {
    try { store.removeItem(STORAGE_KEY); } catch { /* noop */ }
    return null;
  }
  return {
    runId: typeof parsed.runId === "string" ? parsed.runId : null,
    rowsTotal: parsed.rowsTotal,
    anchorXlen: parsed.anchorXlen,
    anchorTs: parsed.anchorTs,
    lastSeenAt: parsed.lastSeenAt,
  };
}

export function writeAnchor(a: IndexingAnchor): void {
  const store = getStorage();
  if (!store) return;
  try { store.setItem(STORAGE_KEY, JSON.stringify(a)); } catch { /* quota */ }
}

export function clearAnchor(): void {
  const store = getStorage();
  if (!store) return;
  try { store.removeItem(STORAGE_KEY); } catch { /* noop */ }
}

// Clamp to [0, 100]. anchorXlen <= 0 ⇒ nothing to index ⇒ 100%. A
// currentXlen above anchorXlen (rare — producer is still appending after
// the anchor was set) clamps to 0% so the bar does not go negative.
export function computePct(anchorXlen: number, currentXlen: number): number {
  if (!Number.isFinite(anchorXlen) || anchorXlen <= 0) return 100;
  const cur = Math.max(0, currentXlen);
  const indexed = anchorXlen - cur;
  if (indexed <= 0) return 0;
  if (indexed >= anchorXlen) return 100;
  return (indexed / anchorXlen) * 100;
}

export interface XlenSample { xlen: number; ts: number }

// Sliding-window rate computation. Returns rows-per-sec drained between the
// oldest and newest sample (positive when xlen is shrinking). Returns null
// when fewer than two samples or no time has elapsed — the caller renders
// an "ETA unknown" badge in that case.
export function computeRatePerSec(samples: XlenSample[]): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const elapsedMs = last.ts - first.ts;
  if (elapsedMs <= 0) return null;
  const drained = first.xlen - last.xlen;
  if (drained <= 0) return 0;
  return (drained / elapsedMs) * 1000;
}

// Push a new sample into a bounded sliding window. Pure (returns a new
// array) so React state updates remain referentially honest.
export function pushSample(
  samples: XlenSample[],
  sample: XlenSample,
  windowSize = 10,
): XlenSample[] {
  const next = samples.concat([sample]);
  if (next.length > windowSize) next.splice(0, next.length - windowSize);
  return next;
}
