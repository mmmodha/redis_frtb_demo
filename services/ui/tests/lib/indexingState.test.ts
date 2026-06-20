// Wave 6.41.E — pure unit tests for the IngestPanel indexing anchor.
// Wave 6.41.E.fix3 — anchor stores `consumedAtAnchor` (monotonic consumer
// counter) instead of `anchorXlen`. Storage key bumped to v2.
// Wave 6.44.B — anchors are per-active-target. Storage key bumped to v3
// with a `:{target_label}` suffix; v2 entries are dropped silently on
// read. read/write/clearAnchor now take a `label: string` argument.
// Wave 6.44.D — bar data source switched from the ingest consumed counter
// to the live FT.SEARCH * doc count. Field renamed consumedAtAnchor →
// indexCountAtAnchor; sample type renamed ConsumedSample →
// IndexCountSample. Storage key bumped to v4.
// Wave 6.52.A — bar data source switched to the ingest worker's
// `consumed` counter. Storage key bumped to "frtb:writing:anchor:v1:".
// Wave 6.52.C — bar data source reverted to the live FT.SEARCH count
// (/admin/index-count). Field renamed `consumedAtAnchor` →
// `indexCountAtAnchor`; sample type renamed `ConsumedSample` →
// `IndexCountSample`. Storage key bumped to "frtb:indexing:anchor:v2:"
// with v1 writing entries dropped silently on read.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ANCHOR_TTL_MS,
  STORAGE_KEY_PREFIX,
  storageKeyFor,
  clearAnchor,
  computePct,
  computeRatePerSec,
  pushSample,
  readAnchor,
  writeAnchor,
  type IndexCountSample,
  type IndexingAnchor,
} from "../../src/lib/indexingState";

const LABEL = "test-label";

// Node 22's experimental globalThis.localStorage shadows jsdom's so the
// standard API is unavailable by default; stub a small in-memory Storage.
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k: string) { map.delete(k); },
    setItem(k: string, v: string) { map.set(k, String(v)); },
  };
}

const originalLocalStorage = globalThis.localStorage;
beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: makeMemoryStorage(),
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: originalLocalStorage,
    configurable: true,
    writable: true,
  });
});

function anchorAt(ts: number, label: string = LABEL): IndexingAnchor {
  return {
    runId: "01HXRUN",
    rowsTotal: 100,
    indexCountAtAnchor: 50,
    anchorTs: ts,
    lastSeenAt: ts,
    targetLabel: label,
  };
}

describe("indexingState — anchor persistence", () => {
  it("returns null when nothing is stored", () => {
    expect(readAnchor(LABEL)).toBeNull();
  });

  it("round-trips writeAnchor + readAnchor", () => {
    const a = anchorAt(1_700_000_000_000);
    writeAnchor(LABEL, a);
    expect(readAnchor(LABEL, a.anchorTs + 1000)).toEqual(a);
    expect(localStorage.getItem(storageKeyFor(LABEL))).not.toBeNull();
  });

  it("uses the v2 indexing label-scoped storage key prefix", () => {
    expect(STORAGE_KEY_PREFIX).toBe("frtb:indexing:anchor:v2:");
    expect(storageKeyFor("local")).toBe("frtb:indexing:anchor:v2:local");
  });

  it("silently drops v1 writing entries left behind by the prior consumed-counter layout", () => {
    // A Wave 6.52.A v1-shaped entry sat at the prior writing key. After
    // upgrade, the v2 indexing reader never consults it; the entry is left
    // in storage and the v2 read returns null (mirrors the v2→v3→v4
    // migration precedent).
    localStorage.setItem(
      "frtb:writing:anchor:v1:" + LABEL,
      JSON.stringify({
        runId: "x", rowsTotal: 100, consumedAtAnchor: 0,
        anchorTs: Date.now(), lastSeenAt: Date.now(),
        targetLabel: LABEL,
      }),
    );
    expect(readAnchor(LABEL)).toBeNull();
  });

  it("expires entries older than 24h and clears them", () => {
    const a = anchorAt(1_000);
    writeAnchor(LABEL, a);
    // 24h + 1ms later
    expect(readAnchor(LABEL, 1_000 + ANCHOR_TTL_MS + 1)).toBeNull();
    // entry should have been cleared as a side effect
    expect(localStorage.getItem(storageKeyFor(LABEL))).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    localStorage.setItem(storageKeyFor(LABEL), "not json");
    expect(readAnchor(LABEL)).toBeNull();
  });

  it("returns null when required numeric fields are missing", () => {
    localStorage.setItem(storageKeyFor(LABEL), JSON.stringify({ runId: "x" }));
    expect(readAnchor(LABEL)).toBeNull();
  });

  it("clearAnchor removes the entry for that label only", () => {
    writeAnchor(LABEL, anchorAt(100));
    clearAnchor(LABEL);
    expect(readAnchor(LABEL)).toBeNull();
  });
});

// Wave 6.44.B — per-target isolation. The DoD scenario: write an anchor
// under label A, switch to label B → read returns null; switch back to A
// → the original anchor is preserved untouched.
describe("indexingState — Wave 6.44.B per-target isolation", () => {
  it("read under a different label returns null even when one is stored", () => {
    const a = anchorAt(1_000, "local");
    writeAnchor("local", a);
    expect(readAnchor("live-standalone")).toBeNull();
  });

  it("writes never collide across labels (A then B then A is preserved)", () => {
    const onA = anchorAt(1_000, "local");
    writeAnchor("local", onA);
    // Switch: read under B returns null.
    expect(readAnchor("live-standalone", onA.anchorTs + 1)).toBeNull();
    // Seed an independent anchor on B.
    const onB: IndexingAnchor = {
      runId: "01HXRUN-B",
      rowsTotal: 50,
      indexCountAtAnchor: 10,
      anchorTs: onA.anchorTs + 2,
      lastSeenAt: onA.anchorTs + 2,
      targetLabel: "live-standalone",
    };
    writeAnchor("live-standalone", onB);
    expect(readAnchor("live-standalone", onB.anchorTs + 1)).toEqual(onB);
    // Switch back to A — original anchor still there, unchanged.
    expect(readAnchor("local", onA.anchorTs + 1000)).toEqual(onA);
  });

  it("clearAnchor on one label does not affect anchors on other labels", () => {
    const ts = Date.now();
    writeAnchor("local", anchorAt(ts, "local"));
    writeAnchor("live-standalone", anchorAt(ts, "live-standalone"));
    clearAnchor("local");
    expect(readAnchor("local")).toBeNull();
    expect(readAnchor("live-standalone")).not.toBeNull();
  });

  it("storage entries live under distinct label-scoped keys", () => {
    writeAnchor("local", anchorAt(100, "local"));
    writeAnchor("live-standalone", anchorAt(100, "live-standalone"));
    expect(localStorage.getItem(storageKeyFor("local"))).not.toBeNull();
    expect(localStorage.getItem(storageKeyFor("live-standalone"))).not.toBeNull();
    expect(storageKeyFor("local")).not.toBe(storageKeyFor("live-standalone"));
  });

  it("backfills targetLabel from the read key when the stored body omits it", () => {
    // Defensive: a body written without a targetLabel field (shouldn't
    // happen from writeAnchor, but guards against hand-written entries)
    // returns with targetLabel = the label used to read.
    localStorage.setItem(
      storageKeyFor("local"),
      JSON.stringify({
        runId: "x", rowsTotal: 100, indexCountAtAnchor: 0,
        anchorTs: Date.now(), lastSeenAt: Date.now(),
      }),
    );
    const r = readAnchor("local");
    expect(r).not.toBeNull();
    expect(r!.targetLabel).toBe("local");
  });
});

describe("indexingState — computePct", () => {
  it("anchor=0, indexCount=50M, rowsTotal=100M → 50%", () => {
    expect(computePct(0, 50_000_000, 100_000_000)).toBe(50);
  });
  it("anchor=1000, indexCount=1750, rowsTotal=1000 → 75%", () => {
    expect(computePct(1_000, 1_750, 1_000)).toBe(75);
  });
  it("clamps to 100% when indexCount reaches anchor+rowsTotal", () => {
    expect(computePct(0, 1_000, 1_000)).toBe(100);
    expect(computePct(500, 2_000, 1_000)).toBe(100);
  });
  it("clamps to 0% when indexCount is below the anchor (index rebuild)", () => {
    expect(computePct(1_000, 500, 1_000)).toBe(0);
  });
  it("returns 100% when rowsTotal <= 0", () => {
    expect(computePct(0, 0, 0)).toBe(100);
    expect(computePct(10, 10, -5)).toBe(100);
  });
});

describe("indexingState — computeRatePerSec sliding window", () => {
  it("returns null when fewer than two samples", () => {
    expect(computeRatePerSec([])).toBeNull();
    expect(computeRatePerSec([{ indexCount: 100, ts: 0 }])).toBeNull();
  });

  it("returns 0 when indexCount is not growing (indexer idle)", () => {
    const samples: IndexCountSample[] = [
      { indexCount: 100, ts: 0 },
      { indexCount: 100, ts: 1000 },
      { indexCount: 100, ts: 2000 },
    ];
    expect(computeRatePerSec(samples)).toBe(0);
  });

  it("computes rows/sec across 5 samples (positive delta of indexCount)", () => {
    // indexCount grows from 0 to 500 over 5 seconds = 100 rows/s.
    const samples: IndexCountSample[] = [
      { indexCount:   0, ts: 0 },
      { indexCount: 100, ts: 1000 },
      { indexCount: 200, ts: 2000 },
      { indexCount: 350, ts: 3500 },
      { indexCount: 500, ts: 5000 },
    ];
    expect(computeRatePerSec(samples)).toBe(100);
  });
});

describe("indexingState — pushSample bounded window", () => {
  it("appends below the window size", () => {
    const s = pushSample([], { indexCount: 1, ts: 1 }, 3);
    expect(s).toEqual([{ indexCount: 1, ts: 1 }]);
  });
  it("evicts the oldest sample once the window is full", () => {
    let s: IndexCountSample[] = [];
    for (let i = 0; i < 5; i++) s = pushSample(s, { indexCount: i, ts: i }, 3);
    expect(s).toEqual([
      { indexCount: 2, ts: 2 },
      { indexCount: 3, ts: 3 },
      { indexCount: 4, ts: 4 },
    ]);
  });
});
