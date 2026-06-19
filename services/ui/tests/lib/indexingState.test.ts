// Wave 6.41.E — pure unit tests for the IngestPanel indexing anchor.

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
  type IndexingAnchor,
  type XlenSample,
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
    anchorXlen: 100,
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
  it("anchor=100M, xlen=50M → 50%", () => {
    expect(computePct(100_000_000, 50_000_000)).toBe(50);
  });
  it("clamps to 100% when xlen drops to 0", () => {
    expect(computePct(1_000, 0)).toBe(100);
  });
  it("clamps to 0% when current exceeds anchor (producer still appending)", () => {
    expect(computePct(100, 150)).toBe(0);
  });
  it("returns 100% when anchorXlen <= 0", () => {
    expect(computePct(0, 0)).toBe(100);
    expect(computePct(-5, 10)).toBe(100);
  });
});

describe("indexingState — computeRatePerSec sliding window", () => {
  it("returns null when fewer than two samples", () => {
    expect(computeRatePerSec([])).toBeNull();
    expect(computeRatePerSec([{ xlen: 100, ts: 0 }])).toBeNull();
  });

  it("returns 0 when xlen is not decreasing", () => {
    const samples: XlenSample[] = [
      { xlen: 100, ts: 0 },
      { xlen: 100, ts: 1000 },
      { xlen: 105, ts: 2000 }, // producer still appending
    ];
    expect(computeRatePerSec(samples)).toBe(0);
  });

  it("computes rows/sec across 5 samples (mock)", () => {
    // 5 samples: xlen drops from 1000 to 500 over 5 seconds = 100 rows/s
    const samples: XlenSample[] = [
      { xlen: 1000, ts: 0 },
      { xlen:  900, ts: 1000 },
      { xlen:  800, ts: 2000 },
      { xlen:  650, ts: 3500 },
      { xlen:  500, ts: 5000 },
    ];
    expect(computeRatePerSec(samples)).toBe(100);
  });
});

describe("indexingState — pushSample bounded window", () => {
  it("appends below the window size", () => {
    const s = pushSample([], { xlen: 1, ts: 1 }, 3);
    expect(s).toEqual([{ xlen: 1, ts: 1 }]);
  });
  it("evicts the oldest sample once the window is full", () => {
    let s: XlenSample[] = [];
    for (let i = 0; i < 5; i++) s = pushSample(s, { xlen: 10 - i, ts: i }, 3);
    expect(s).toEqual([
      { xlen: 8, ts: 2 },
      { xlen: 7, ts: 3 },
      { xlen: 6, ts: 4 },
    ]);
  });
});
