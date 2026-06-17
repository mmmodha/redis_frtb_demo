// Wave 6.21 — heavy/light runtime Redis client pool.
//
// The 2026-06-17 incident showed that a single shared runtime client meant a
// slow FT.AGGREGATE held the socket and every unrelated /observability call
// queued behind it. This suite exercises the round-robin pool that replaces
// the singleton, asserting: distribution across slots, per-member recycle
// on simulated timeout, lockstep invalidation on setActiveTarget, pool
// independence (heavy ≠ light), default-heavy fallback, and the head-of-line
// blocking scenario.
//
// The Redis factory is replaced with a stub that captures construction; no
// TCP sockets are opened.

import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getRuntimePoolForTests,
  __setRuntimeClientFactoryForTests,
  getActiveRedisRuntimeClient,
  getPoolMemberInfo,
  resetActiveTarget,
  setActiveTarget,
} from "../src/active-target.ts";

// Build a fake ioredis-like client. The Proxy returned to callers wraps
// every method so we expose a stub object with `.options`, `.disconnect()`,
// `.on()`, and an arbitrary command surface that returns `Promise.resolve(0)`
// by default. Tests can override the command behaviour via `commandImpl`.
function makeFakeClient(commandTimeout: number, commandImpl?: () => unknown): Redis {
  const listeners: Array<(err: unknown) => void> = [];
  const fake = {
    options: { commandTimeout, host: "fake", db: 0 },
    on(event: string, fn: (err: unknown) => void): unknown {
      if (event === "error") listeners.push(fn);
      return this;
    },
    emit(event: string, payload: unknown): void {
      if (event === "error") for (const fn of listeners) fn(payload);
    },
    disconnect(): void { /* no-op */ },
    // Default command implementation: every method returns Promise.resolve(0).
    info: () => commandImpl ? commandImpl() : Promise.resolve(""),
    get: () => commandImpl ? commandImpl() : Promise.resolve(null),
    dbsize: () => commandImpl ? commandImpl() : Promise.resolve(0),
    scan: () => commandImpl ? commandImpl() : Promise.resolve(["0", []]),
  };
  return fake as unknown as Redis;
}

beforeEach(() => {
  resetActiveTarget();
  delete process.env.REDIS_URL;
  delete process.env.RUNTIME_REDIS_COMMAND_TIMEOUT_MS;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_LIGHT;
  delete process.env.RUNTIME_REDIS_POOL_DRAIN_GRACE_MS;
  __setRuntimeClientFactoryForTests((_t, _c, opts) => makeFakeClient(opts.commandTimeout));
  setActiveTarget({ host: "pool.example.com", port: 6379, tls: false, db: 0, label: "pool" });
});
afterEach(() => {
  resetActiveTarget();
  __setRuntimeClientFactoryForTests(null);
});

describe("Wave 6.21 — round-robin pool distribution", () => {
  it("distributes 8 acquisitions across 4 heavy pool members evenly", () => {
    // Acquire 8 times; each should land on a different slot in lockstep
    // round-robin (slot 0, 1, 2, 3, 0, 1, 2, 3).
    const wrappers = Array.from({ length: 8 }, () => getActiveRedisRuntimeClient());
    // Resolve back to the underlying slot identity by inspecting the pool.
    const snap = __getRuntimePoolForTests("heavy");
    expect(snap.members.length).toBe(4);
    // Every slot should have a live wrapper after 8 acquisitions.
    for (const m of snap.members) expect(m.wrapper).not.toBeNull();
    // The first 4 acquisitions return distinct wrappers; the next 4 return
    // the SAME 4 wrappers (cached per slot until the slot is recycled).
    expect(new Set(wrappers).size).toBe(4);
    // Each slot must carry the M1 identity: heavy:0..3, generation 1.
    for (let i = 0; i < 4; i++) {
      const info = getPoolMemberInfo("heavy", i);
      expect(info?.id).toBe(`heavy:${i}`);
      expect(info?.generation).toBe(1);
    }
  });
});

describe("Wave 6.21 — per-member recycle on Command timed out", () => {
  it("marks a member stale on a 'Command timed out' rejection and rebuilds it on the next acquisition; pool size stays at 4", async () => {
    // Acquire enough times to materialise all 4 heavy slots.
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient();
    const snapBefore = __getRuntimePoolForTests("heavy");
    const slotZeroClient = snapBefore.members[0]!.client;
    expect(slotZeroClient).not.toBeNull();
    // Trigger the recycle hook by emitting a Command timed out error event.
    // The error-recycle listener marks the slot stale; the next acquisition
    // for slot 0 rebuilds.
    (slotZeroClient as unknown as { emit: (e: string, p: unknown) => void })
      .emit("error", Object.assign(new Error("Command timed out"), { code: undefined }));
    const snapAfter = __getRuntimePoolForTests("heavy");
    expect(snapAfter.members[0]!.client).toBeNull();
    expect(snapAfter.members.length).toBe(4); // size invariant preserved
    // Advance round-robin until we land on slot 0 again. Pool stays at 4
    // members; slot 0 is rebuilt (new client identity, generation bumps).
    const genBefore = snapBefore.members[0]!.generation;
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient();
    const slotZeroInfo = getPoolMemberInfo("heavy", 0);
    expect(slotZeroInfo?.generation).toBe(genBefore + 1);
    expect(__getRuntimePoolForTests("heavy").members.length).toBe(4);
  });
});

describe("Wave 6.21 — lockstep invalidation on setActiveTarget", () => {
  it("setActiveTarget rebuilds all 4 heavy + 4 light pool members", async () => {
    // Materialise all slots in both pools.
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy");
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("light");
    const heavyBefore = __getRuntimePoolForTests("heavy");
    const lightBefore = __getRuntimePoolForTests("light");
    // Disable drain grace so the test does not sleep waiting for timers.
    process.env.RUNTIME_REDIS_POOL_DRAIN_GRACE_MS = "0";
    setActiveTarget({ host: "rotated.example.com", port: 6379, tls: false, db: 0, label: "rotated" });
    // After the swap, the pool slots are blanked synchronously; the very
    // next acquisition per slot rebuilds against the new target.
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy");
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("light");
    const heavyAfter = __getRuntimePoolForTests("heavy");
    const lightAfter = __getRuntimePoolForTests("light");
    for (let i = 0; i < 4; i++) {
      expect(heavyAfter.members[i]!.client).not.toBe(heavyBefore.members[i]!.client);
      expect(lightAfter.members[i]!.client).not.toBe(lightBefore.members[i]!.client);
    }
  });
});

describe("Wave 6.21 — heavy/light pool independence", () => {
  it("staling a heavy pool member does NOT affect any light pool member", () => {
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy");
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("light");
    const heavySlot0 = __getRuntimePoolForTests("heavy").members[0]!.client!;
    const lightBefore = __getRuntimePoolForTests("light");
    (heavySlot0 as unknown as { emit: (e: string, p: unknown) => void })
      .emit("error", Object.assign(new Error("Command timed out"), {}));
    const lightAfter = __getRuntimePoolForTests("light");
    for (let i = 0; i < 4; i++) {
      expect(lightAfter.members[i]!.client).toBe(lightBefore.members[i]!.client);
      expect(lightAfter.members[i]!.generation).toBe(lightBefore.members[i]!.generation);
    }
  });
});

describe("Wave 6.21 — default category is heavy", () => {
  it("getActiveRedisRuntimeClient() with no argument materialises only the heavy pool", () => {
    getActiveRedisRuntimeClient();
    expect(__getRuntimePoolForTests("heavy").members.length).toBe(4);
    // Light pool has not been touched (no acquisitions yet); members array
    // is still empty until something opts in to "light".
    expect(__getRuntimePoolForTests("light").members.length).toBe(0);
  });
});

describe("Wave 6.21 — head-of-line blocking eliminated by pooling", () => {
  it("10 concurrent calls (1 slow, 9 fast) — the 9 fast calls complete in <100ms without serialising behind the slow one", async () => {
    // Pool of 10 so each of the 10 acquisitions in this test lands on a
    // distinct slot. Without the pool, a single shared client would queue
    // every call behind the slow command and never resolve. With the pool,
    // round-robin distributes the slow call to one slot (slot 0) and the
    // other 9 acquisitions land on independent slots that respond fast.
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "10";
    let constructedCount = 0;
    __setRuntimeClientFactoryForTests((_t, _c, opts) => {
      const isFirstSlot = constructedCount === 0;
      constructedCount += 1;
      const slow = (): Promise<unknown> => new Promise(() => { /* never resolves */ });
      const fast = (): Promise<unknown> => Promise.resolve("ok");
      return makeFakeClient(opts.commandTimeout, isFirstSlot ? slow : fast);
    });
    const t0 = Date.now();
    // 10 concurrent acquisitions: slot 0 gets the slow client, the rest
    // get fast ones. Fire commands on all 10 concurrently; await only the
    // fast 9 (the slow one is intentionally left dangling — without the
    // pool it would block ALL of them).
    const promises = Array.from({ length: 10 }, (_, i) => {
      const c = getActiveRedisRuntimeClient()!;
      const p = (c as unknown as { get: () => Promise<unknown> }).get();
      return { i, p };
    });
    // Drop the slow one (slot 0); await the 9 fast.
    const fast = promises.filter((x) => x.i !== 0).map((x) => x.p);
    const fastResults = await Promise.all(fast);
    const elapsed = Date.now() - t0;
    expect(fastResults.length).toBe(9);
    for (const r of fastResults) expect(r).toBe("ok");
    expect(elapsed).toBeLessThan(100);
  });
});

describe("Wave 6.21 (M6) — graceful drain on setActiveTarget", () => {
  it("does NOT disconnect the old client synchronously; new acquisitions route to fresh clients while the old one keeps serving", async () => {
    process.env.RUNTIME_REDIS_POOL_DRAIN_GRACE_MS = "5000"; // plenty of headroom
    vi.useFakeTimers();
    try {
      // Materialise slot 0 against the original target.
      const before = getActiveRedisRuntimeClient()!;
      const oldClient = __getRuntimePoolForTests("heavy").members[0]!.client!;
      let disconnected = false;
      (oldClient as unknown as { disconnect: () => void }).disconnect = () => { disconnected = true; };
      // Rotate the target.
      setActiveTarget({ host: "rotated.example.com", port: 6379, tls: false, db: 0, label: "rotated" });
      // Old client MUST still be alive immediately after the swap (drain grace).
      expect(disconnected).toBe(false);
      // Next acquisition lands on a freshly built client, not the old one.
      const after = getActiveRedisRuntimeClient()!;
      expect(after).not.toBe(before);
      // Advance the fake timer past the grace window; old client disconnects.
      vi.advanceTimersByTime(5001);
      expect(disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
