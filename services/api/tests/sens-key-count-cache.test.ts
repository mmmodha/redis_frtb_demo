import { describe, it, expect, beforeEach } from "vitest";
import {
  getSensKeyCountSnapshot,
  setSensKeyCountSnapshot,
  _testResetSensKeyCountCache,
} from "../src/lib/sens-key-count-cache.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

describe("sens-key-count-cache (DBSIZE)", () => {
  beforeEach(() => { _testResetSensKeyCountCache(); });

  it("reads total keys from DBSIZE", async () => {
    const fr = fakeRedis();
    fr.setDbsize(4_400_000);
    const snap = await getSensKeyCountSnapshot("local", fr);
    expect(snap).toMatchObject({ count: 4_400_000, refreshing: false, index_name: "dbsize" });
    expect(fr.calls.find((c) => c.command === "DBSIZE")).toBeDefined();
    expect(fr.calls.find((c) => c.command === "SCAN")).toBeUndefined();
  });

  it("serves cached count without a second DBSIZE within the refresh window", async () => {
    const fr = fakeRedis();
    fr.setDbsize(100);
    await getSensKeyCountSnapshot("local", fr);
    const callsAfterWarm = fr.calls.filter((c) => c.command === "DBSIZE").length;
    const snap = await getSensKeyCountSnapshot("local", fr);
    expect(snap.count).toBe(100);
    expect(fr.calls.filter((c) => c.command === "DBSIZE").length).toBe(callsAfterWarm);
  });

  it("setSensKeyCountSnapshot seeds the cache (e.g. after flush)", async () => {
    setSensKeyCountSnapshot("local", 0);
    const fr = fakeRedis();
    fr.setDbsize(99_999);
    const snap = await getSensKeyCountSnapshot("local", fr);
    expect(snap.count).toBe(0);
    expect(fr.calls.find((c) => c.command === "DBSIZE")).toBeUndefined();
  });
});
