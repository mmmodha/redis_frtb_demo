// Wave 6.32.A — bounds the drain+respawn window inside rebuild() with a
// configurable timeout so a hung `multi.stop()` or `opts.spawn()` no longer
// leaks the rebuilding mutex. Asserts the timeout fires, the flag clears in
// finally, RebuildTimeoutError surfaces, and the next rebuild is accepted.

import { describe, it, expect } from "vitest";
import {
  createShardRuntime,
  RebuildTimeoutError,
  RebuildBusyError,
} from "../src/shard-runtime.ts";
import type { MultiConsumer } from "../src/multi-consumer.ts";

const silentLogger = { warn: () => undefined };

describe("createShardRuntime rebuild() timeout (Wave 6.32.A)", () => {
  it("times out a hung spawn, clears the rebuilding flag, and accepts the next rebuild", async () => {
    let spawnCalls = 0;
    let hangResolve: (() => void) | null = null;
    const runtime = createShardRuntime({
      baseStream: "test",
      initialTotalShards: 1,
      initialAssignmentSpec: "all",
      rebuildTimeoutMs: 30,
      logger: silentLogger,
      spawn: () => {
        spawnCalls += 1;
        return new Promise<MultiConsumer>((resolve) => {
          hangResolve = () => resolve({} as MultiConsumer);
        });
      },
    });

    await expect(runtime.rebuild()).rejects.toBeInstanceOf(RebuildTimeoutError);
    expect(spawnCalls).toBe(1);
    expect(runtime.snapshot().rebuilding).toBe(false);
    expect(runtime.snapshot().rebuild_started_at).toBeUndefined();

    // Mutex must be released — a follow-up call enters spawn (and times out
    // again rather than 409-ing with RebuildBusyError).
    await expect(runtime.rebuild()).rejects.toBeInstanceOf(RebuildTimeoutError);
    expect(spawnCalls).toBe(2);
    expect(runtime.snapshot().rebuilding).toBe(false);

    // Free the dangling promises so vitest doesn't keep them open.
    hangResolve?.();
  });

  it("exposes rebuilding + rebuild_started_at in snapshot while rebuild is in flight", async () => {
    let release: ((m: MultiConsumer) => void) | null = null;
    const runtime = createShardRuntime({
      baseStream: "test",
      initialTotalShards: 1,
      initialAssignmentSpec: "all",
      rebuildTimeoutMs: 5_000,
      logger: silentLogger,
      spawn: () => new Promise<MultiConsumer>((resolve) => { release = resolve; }),
    });

    const pending = runtime.rebuild();
    // Yield so rebuild() reaches the await on spawn().
    await new Promise((r) => setTimeout(r, 1));

    const snap = runtime.snapshot();
    expect(snap.rebuilding).toBe(true);
    expect(typeof snap.rebuild_started_at).toBe("string");
    expect(() => new Date(snap.rebuild_started_at!).toISOString()).not.toThrow();

    release!({ stop: async () => undefined } as unknown as MultiConsumer);
    await pending;

    const after = runtime.snapshot();
    expect(after.rebuilding).toBe(false);
    expect(after.rebuild_started_at).toBeUndefined();
  });

  // Wave 6.43.A — a drain-stage timeout left the orphaned `multi` reference
  // live, so the next rebuild would call .stop() on the same dead client and
  // hang again. The finally block must null the reference so a working spawn
  // is reached without operator intervention (no /ingest/shards/reset).
  it("nulls the orphaned multi after a drain timeout so the next rebuild self-heals", async () => {
    let hangStopResolve: (() => void) | null = null;
    let stopCalls = 0;
    const hangingMulti = {
      stop: () => {
        stopCalls += 1;
        return new Promise<void>((resolve) => { hangStopResolve = () => resolve(); });
      },
    } as unknown as MultiConsumer;

    const workingMulti = { stop: async () => undefined } as unknown as MultiConsumer;
    const spawnReturns: MultiConsumer[] = [hangingMulti, workingMulti];
    let spawnCalls = 0;
    const runtime = createShardRuntime({
      baseStream: "test",
      initialTotalShards: 1,
      initialAssignmentSpec: "all",
      rebuildTimeoutMs: 30,
      logger: silentLogger,
      spawn: () => {
        spawnCalls += 1;
        return Promise.resolve(spawnReturns.shift()!);
      },
    });

    // Prime the runtime so `multi` references the hanging consumer.
    await runtime.rebuild();
    expect(spawnCalls).toBe(1);

    // Second rebuild: drain hangs → RebuildTimeoutError; multi must be nulled.
    await expect(runtime.rebuild()).rejects.toBeInstanceOf(RebuildTimeoutError);
    expect(stopCalls).toBe(1);
    expect(runtime.getMulti()).toBeNull();

    // Third rebuild: drain is skipped (multi === null), the working spawn
    // succeeds, and stop() is NOT called a second time on the dead client.
    await runtime.rebuild();
    expect(spawnCalls).toBe(2);
    expect(stopCalls).toBe(1);
    expect(runtime.getMulti()).toBe(workingMulti);

    // Free the dangling stop() promise so vitest exits cleanly.
    hangStopResolve?.();
  });

  it("returns RebuildBusyError when a second rebuild starts while one is in flight", async () => {
    let release: ((m: MultiConsumer) => void) | null = null;
    const runtime = createShardRuntime({
      baseStream: "test",
      initialTotalShards: 1,
      initialAssignmentSpec: "all",
      rebuildTimeoutMs: 5_000,
      logger: silentLogger,
      spawn: () => new Promise<MultiConsumer>((resolve) => { release = resolve; }),
    });

    const first = runtime.rebuild();
    await new Promise((r) => setTimeout(r, 1));
    await expect(runtime.rebuild()).rejects.toBeInstanceOf(RebuildBusyError);

    release!({ stop: async () => undefined } as unknown as MultiConsumer);
    await first;
  });
});
