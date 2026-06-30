import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  INGEST_LAST_RUN_KEYS_STORAGE_KEY,
  clearLastRunKeysAdded,
  keysAddedFromBaseline,
  readLastRunKeysAdded,
  writeLastRunKeysAdded,
} from "../../src/lib/ingestLastRunKeys";

describe("ingestLastRunKeys", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("round-trips last run keys added", () => {
    writeLastRunKeysAdded({
      run_id: "01RUN",
      keys_added: 100_000,
      completed_at: 1_700_000_000_000,
    });
    expect(readLastRunKeysAdded()).toEqual({
      run_id: "01RUN",
      keys_added: 100_000,
      completed_at: 1_700_000_000_000,
    });
    expect(localStorage.getItem(INGEST_LAST_RUN_KEYS_STORAGE_KEY)).toBeTruthy();
  });

  it("clears persisted last run keys", () => {
    writeLastRunKeysAdded({
      run_id: "01RUN",
      keys_added: 50,
      completed_at: Date.now(),
    });
    clearLastRunKeysAdded();
    expect(readLastRunKeysAdded()).toBeNull();
  });

  it("keysAddedFromBaseline never returns negative deltas", () => {
    expect(keysAddedFromBaseline(900, 1_000)).toBe(0);
    expect(keysAddedFromBaseline(1_100_000, 1_000_000)).toBe(100_000);
    expect(keysAddedFromBaseline(1_000, null)).toBeNull();
  });
});
