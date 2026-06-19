// Wave 6.41.E — pure unit tests for the IngestPanel indexing anchor.
// Wave 6.41.E.fix3 — anchor stores `consumedAtAnchor` (monotonic consumer
// counter) instead of `anchorXlen`. Storage key bumped to v2.
// Wave 6.44.B — anchors are per-active-target. Storage key bumped to v3
// with a `:{target_label}` suffix; v2 entries are dropped silently on
// read. read/write/clearAnchor now take a `label: string` argument.

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
  type ConsumedSample,
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
    consumedAtAnchor: 50,
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

  it("uses the v3 label-scoped storage key prefix", () => {
    expect(STORAGE_KEY_PREFIX).toBe("frtb:indexing:anchor:v3:");
    expect(storageKeyFor("local")).toBe("frtb:indexing:anchor:v3:local");
  });

  it("silently drops v2 entries left behind by the prior layout", () => {
    // A v2-shaped entry sat at the old unscoped key. After upgrade, the
    // v3 reader never consults it; the entry is left in storage and the
    // v3 read returns null (mirrors the v1→v2 migration precedent).
    localStorage.setItem(
      "frtb:indexing:anchor:v2",
      JSON.stringify({
        runId: "x", rowsTotal: 100, consumedAtAnchor: 0,
        anchorTs: Date.now(), lastSeenAt: Date.now(),
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
      consumedAtAnchor: 10,
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
        runId: "x", rowsTotal: 100, consumedAtAnchor: 0,
        anchorTs: Date.now(), lastSeenAt: Date.now(),
      }),
    );
    const r = readAnchor("local");
    expect(r).not.toBeNull();
    expect(r!.targetLabel).toBe("local");
  });
});

describe("indexingState — computePct", () => {
  it("anchor=0, consumed=50M, rowsTotal=100M → 50%", () => {
    expect(computePct(0, 50_000_000, 100_000_000)).toBe(50);
  });
  it("anchor=1000, consumed=1750, rowsTotal=1000 → 75%", () => {
    expect(computePct(1_000, 1_750, 1_000)).toBe(75);
  });
  it("clamps to 100% when consumed reaches anchor+rowsTotal", () => {
    expect(computePct(0, 1_000, 1_000)).toBe(100);
    expect(computePct(500, 2_000, 1_000)).toBe(100);
  });
  it("clamps to 0% when consumed is below the anchor (ingest restart)", () => {
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
    expect(computeRatePerSec([{ consumed: 100, xlen: 0, ts: 0 }])).toBeNull();
  });

  it("returns 0 when consumed is not growing (consumer idle)", () => {
    const samples: ConsumedSample[] = [
      { consumed: 100, xlen: 50, ts: 0 },
      { consumed: 100, xlen: 50, ts: 1000 },
      { consumed: 100, xlen: 60, ts: 2000 },
    ];
    expect(computeRatePerSec(samples)).toBe(0);
  });

  it("computes rows/sec across 5 samples (positive delta of consumed)", () => {
    // consumed grows from 0 to 500 over 5 seconds = 100 rows/s.
    const samples: ConsumedSample[] = [
      { consumed:   0, xlen: 1000, ts: 0 },
      { consumed: 100, xlen:  900, ts: 1000 },
      { consumed: 200, xlen:  800, ts: 2000 },
      { consumed: 350, xlen:  650, ts: 3500 },
      { consumed: 500, xlen:  500, ts: 5000 },
    ];
    expect(computeRatePerSec(samples)).toBe(100);
  });
});

describe("indexingState — pushSample bounded window", () => {
  it("appends below the window size", () => {
    const s = pushSample([], { consumed: 1, xlen: 0, ts: 1 }, 3);
    expect(s).toEqual([{ consumed: 1, xlen: 0, ts: 1 }]);
  });
  it("evicts the oldest sample once the window is full", () => {
    let s: ConsumedSample[] = [];
    for (let i = 0; i < 5; i++) s = pushSample(s, { consumed: i, xlen: 10 - i, ts: i }, 3);
    expect(s).toEqual([
      { consumed: 2, xlen: 8, ts: 2 },
      { consumed: 3, xlen: 7, ts: 3 },
      { consumed: 4, xlen: 6, ts: 4 },
    ]);
  });
});
