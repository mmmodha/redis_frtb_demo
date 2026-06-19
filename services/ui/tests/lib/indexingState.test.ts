// Wave 6.41.E — pure unit tests for the IngestPanel indexing anchor.
// Wave 6.41.E.fix3 — anchor stores `consumedAtAnchor` (monotonic consumer
// counter) instead of `anchorXlen`. Storage key bumped to v2.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ANCHOR_TTL_MS,
  STORAGE_KEY,
  clearAnchor,
  computePct,
  computeRatePerSec,
  pushSample,
  readAnchor,
  writeAnchor,
  type ConsumedSample,
  type IndexingAnchor,
} from "../../src/lib/indexingState";

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

function anchorAt(ts: number): IndexingAnchor {
  return {
    runId: "01HXRUN",
    rowsTotal: 100,
    consumedAtAnchor: 50,
    anchorTs: ts,
    lastSeenAt: ts,
  };
}

describe("indexingState — anchor persistence", () => {
  it("returns null when nothing is stored", () => {
    expect(readAnchor()).toBeNull();
  });

  it("round-trips writeAnchor + readAnchor", () => {
    const a = anchorAt(1_700_000_000_000);
    writeAnchor(a);
    expect(readAnchor(a.anchorTs + 1000)).toEqual(a);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("uses the v2 storage key (v1 entries are silently dropped on read)", () => {
    expect(STORAGE_KEY).toBe("frtb:indexing:anchor:v2");
    // A v1-shaped entry (anchorXlen field, no consumedAtAnchor) parses to
    // missing-required-fields → readAnchor returns null.
    localStorage.setItem(
      "frtb:indexing:anchor:v2",
      JSON.stringify({ runId: "x", rowsTotal: 100, anchorXlen: 100, anchorTs: Date.now(), lastSeenAt: Date.now() }),
    );
    expect(readAnchor()).toBeNull();
  });

  it("expires entries older than 24h and clears them", () => {
    const a = anchorAt(1_000);
    writeAnchor(a);
    // 24h + 1ms later
    expect(readAnchor(1_000 + ANCHOR_TTL_MS + 1)).toBeNull();
    // entry should have been cleared as a side effect
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not json");
    expect(readAnchor()).toBeNull();
  });

  it("returns null when required numeric fields are missing", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ runId: "x" }));
    expect(readAnchor()).toBeNull();
  });

  it("clearAnchor removes the entry", () => {
    writeAnchor(anchorAt(100));
    clearAnchor();
    expect(readAnchor()).toBeNull();
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
