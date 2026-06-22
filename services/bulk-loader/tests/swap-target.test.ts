// Wave 7.0.6.17 — swapTarget unit tests.
//
// Covers the routine's DoD bullets:
//   • Happy path: drain → teardown → rebuild → atomic swap → accepting=true.
//   • Concurrent ticks no-op via swap-in-progress mutex.
//   • Idempotent: swap into the already-bound target is a fast no-op.
//   • Drain timeout aborts the swap with `target_stale=true`, accepting=false.
//   • Rebuild error aborts the swap with last_swap_error set, accepting=false.
//   • Stale-target detection: api divergence flips stale only when watcher is
//     disabled or a prior swap failed.

import { describe, it, expect, vi } from "vitest";
import {
  createBulkLoaderState,
  swapTarget,
  updateApiActiveTarget,
  formatStaleReason,
  type BulkLoaderState,
  type RebuiltRuntime,
  type SwapDeps,
  type SwapLogger,
} from "../src/swap-target.ts";
import { createWorkerPool, type WorkerPool } from "../src/pool.ts";
import { createDispatcher, type DispatcherHandle } from "../src/dispatcher.ts";
import { FakeClient } from "./helpers/fake-client.ts";
import { FakeWriteClient } from "./helpers/fake-write-client.ts";
import type { ActiveTargetFull } from "@frtb/redis-client";

function makeTarget(label: string, host = "10.0.0.1", port = 12000): ActiveTargetFull {
  return { host, port, tls: false, db: 0, label, version: 7 };
}

function makePool(size = 2): WorkerPool {
  return createWorkerPool({
    size,
    redisFactory: () => new FakeClient(),
    heartbeatMs: 60_000,
    logger: { info: () => { } },
  });
}

function makeDispatcher(): DispatcherHandle {
  return createDispatcher({
    workerClients: [new FakeWriteClient(), new FakeWriteClient()],
    batchSize: 1,
    idleFlushMs: 0,
    highWater: 64,
  });
}

function noisyLogger(): SwapLogger & { events: Array<{ level: string; obj: object; msg: string }> } {
  const events: Array<{ level: string; obj: object; msg: string }> = [];
  return {
    events,
    info: (obj, msg) => events.push({ level: "info", obj, msg }),
    warn: (obj, msg) => events.push({ level: "warn", obj, msg }),
    error: (obj, msg) => events.push({ level: "error", obj, msg }),
  };
}

function initState(): BulkLoaderState {
  return createBulkLoaderState({
    pool: makePool(),
    dispatcher: makeDispatcher(),
    checkpointer: null,
    bootstrapCheckpoints: new Map(),
    boundTarget: { host: "127.0.0.1", port: 12000, label: "localcluster" },
    boundVersion: 1,
    targetWatcher: "enabled",
  });
}

describe("createBulkLoaderState", () => {
  it("initialises accepting=true, no stale, no swap error", () => {
    const s = initState();
    expect(s.accepting).toBe(true);
    expect(s.targetStale).toBe(false);
    expect(s.targetSwapCount).toBe(0);
    expect(s.lastSwapError).toBeNull();
    expect(s.swapInFlight).toBe(false);
    expect(s.targetWatcher).toBe("enabled");
    expect(s.apiActiveTarget).toBeNull();
  });
});

describe("swapTarget — happy path", () => {
  it("drains, tears down, rebuilds, and atomically swaps the runtime", async () => {
    const state = initState();
    const oldPool = state.pool;
    const oldDispatcher = state.dispatcher!;
    const drainSpy = vi.spyOn(oldDispatcher, "drain");
    const dStopSpy = vi.spyOn(oldDispatcher, "stop");
    const pStopSpy = vi.spyOn(oldPool, "stop");

    const newPool = makePool();
    const newDispatcher = makeDispatcher();
    const built: RebuiltRuntime = {
      pool: newPool,
      dispatcher: newDispatcher,
      checkpointer: null,
      bootstrapCheckpoints: new Map(),
    };
    const log = noisyLogger();
    const deps: SwapDeps = {
      rebuildFromTarget: vi.fn(async () => built),
      logger: log,
    };
    const result = await swapTarget(state, makeTarget("cloud", "cloud-x", 6379), deps);
    expect(result.ok).toBe(true);
    expect(drainSpy).toHaveBeenCalled();
    expect(dStopSpy).toHaveBeenCalled();
    expect(pStopSpy).toHaveBeenCalled();
    expect(state.pool).toBe(newPool);
    expect(state.dispatcher).toBe(newDispatcher);
    expect(state.boundTarget).toEqual({ host: "cloud-x", port: 6379, label: "cloud" });
    expect(state.boundVersion).toBe(7);
    expect(state.targetSwapCount).toBe(1);
    expect(state.accepting).toBe(true);
    expect(state.targetStale).toBe(false);
    expect(state.lastSwapError).toBeNull();
    expect(log.events.some((e) => e.msg === "target swap complete")).toBe(true);

    // Cleanup the leftover live pool/dispatcher so vitest exits cleanly.
    await newDispatcher.stop();
    await newPool.stop();
  });
});

describe("swapTarget — concurrent + idempotent", () => {
  it("no-ops when the target matches the bound one (lastSwapError=null)", async () => {
    const state = initState();
    const rebuildSpy = vi.fn();
    const deps: SwapDeps = {
      rebuildFromTarget: rebuildSpy as unknown as SwapDeps["rebuildFromTarget"],
      logger: noisyLogger(),
    };
    const r = await swapTarget(state, makeTarget("localcluster", "127.0.0.1", 12000), deps);
    expect(r.ok).toBe(true);
    expect(rebuildSpy).not.toHaveBeenCalled();
    // boundVersion gets refreshed though.
    expect(state.boundVersion).toBe(7);
    await state.dispatcher!.stop();
    await state.pool.stop();
  });

  it("a second swapTarget while one is in flight returns ok+skipped without re-tearing", async () => {
    const state = initState();
    // Hold the rebuild promise so the first swap is mid-flight when the
    // second call arrives.
    let release!: () => void;
    const block = new Promise<void>((resolve) => { release = resolve; });
    const built: RebuiltRuntime = {
      pool: makePool(),
      dispatcher: makeDispatcher(),
      checkpointer: null,
      bootstrapCheckpoints: new Map(),
    };
    const rebuildSpy = vi.fn(async () => { await block; return built; });
    const deps: SwapDeps = { rebuildFromTarget: rebuildSpy, logger: noisyLogger() };

    const first = swapTarget(state, makeTarget("cloud"), deps);
    // Yield enough turns for the first swap to advance past drain → stop →
    // rebuild and park inside the awaited `block` Promise. swapInFlight is
    // set synchronously at the top of swapTarget, but we also want
    // rebuildSpy to have been invoked exactly once by the time we race
    // against it from the second caller.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(state.swapInFlight).toBe(true);
    const second = await swapTarget(state, makeTarget("cloud"), deps);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);

    release();
    await first;
    // Total invocations across both calls is 1 — the skipped tick never
    // hit the rebuild factory.
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    await built.dispatcher.stop();
    await built.pool.stop();
  });
});

describe("swapTarget — failure modes", () => {
  it("rebuild error: accepting stays false, lastSwapError + target_stale set", async () => {
    const state = initState();
    const log = noisyLogger();
    const deps: SwapDeps = {
      rebuildFromTarget: async () => { throw new Error("ECONNREFUSED cloud:6379"); },
      logger: log,
    };
    const r = await swapTarget(state, makeTarget("cloud"), deps);
    expect(r.ok).toBe(false);
    expect(state.accepting).toBe(false);
    expect(state.lastSwapError).toMatch(/ECONNREFUSED/);
    expect(state.targetStale).toBe(true);
    expect(state.targetStaleReason).toMatch(/stale target/);
    expect(state.boundTarget.label).toBe("localcluster"); // unchanged
    expect(state.targetSwapCount).toBe(0);
    expect(log.events.some((e) => e.level === "error" && e.msg.includes("rebuild errored"))).toBe(true);
  });

  it("drain timeout: accepting stays false, swap aborted, lastSwapError set", async () => {
    const state = initState();
    // Replace the dispatcher with one whose drain() hangs.
    let drainResolve!: () => void;
    const hangingDrain = new Promise<void>((resolve) => { drainResolve = resolve; });
    state.dispatcher = {
      ...state.dispatcher!,
      drain: () => hangingDrain,
    };
    const log = noisyLogger();
    const deps: SwapDeps = {
      rebuildFromTarget: vi.fn(),
      drainTimeoutMs: 20,
      logger: log,
    };
    const r = await swapTarget(state, makeTarget("cloud"), deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/drain exceeded/);
    expect(state.accepting).toBe(false);
    expect(state.lastSwapError).toMatch(/drain exceeded/);
    expect(state.targetStale).toBe(true);
    // Rebuild MUST NOT have been called — we abort before teardown.
    expect((deps.rebuildFromTarget as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    expect(log.events.some((e) => e.msg.includes("drain timed out"))).toBe(true);
    drainResolve(); // free the hanging promise so vitest exits
  });
});

describe("updateApiActiveTarget — stale flag logic", () => {
  it("does not flag stale when api matches the bound target", () => {
    const s = initState();
    const flipped = updateApiActiveTarget(s, { host: "127.0.0.1", port: 12000, label: "localcluster" }, 5);
    expect(flipped).toBe(false);
    expect(s.targetStale).toBe(false);
  });

  it("does not flag stale on divergence when watcher is enabled and no prior swap failure", () => {
    const s = initState();
    updateApiActiveTarget(s, { host: "cloud-x", port: 6379, label: "cloud" }, 8);
    expect(s.targetStale).toBe(false);
    expect(s.apiActiveTarget?.label).toBe("cloud");
  });

  it("flags stale on divergence when watcher is disabled", () => {
    const s = initState();
    s.targetWatcher = "disabled";
    const flipped = updateApiActiveTarget(s, { host: "cloud-x", port: 6379, label: "cloud" }, 8);
    expect(flipped).toBe(true);
    expect(s.targetStale).toBe(true);
    expect(s.targetStaleReason).toMatch(/INTERNAL_API_TOKEN/);
  });

  it("flags stale on divergence when prior swap failed", () => {
    const s = initState();
    s.lastSwapError = "rebuild failed: ECONNREFUSED";
    const flipped = updateApiActiveTarget(s, { host: "cloud-x", port: 6379, label: "cloud" }, 8);
    expect(flipped).toBe(true);
    expect(s.targetStale).toBe(true);
  });

  it("clears stale automatically when api converges back to the bound target", () => {
    const s = initState();
    s.targetWatcher = "disabled";
    updateApiActiveTarget(s, { host: "cloud-x", port: 6379, label: "cloud" }, 8);
    expect(s.targetStale).toBe(true);
    const flipped = updateApiActiveTarget(s, { host: "127.0.0.1", port: 12000, label: "localcluster" }, 9);
    expect(flipped).toBe(true);
    expect(s.targetStale).toBe(false);
    expect(s.targetStaleReason).toBeNull();
  });
});

describe("formatStaleReason", () => {
  it("includes restart hint and INTERNAL_API_TOKEN when watcher disabled", () => {
    const r = formatStaleReason(
      { host: "127.0.0.1", port: 12000, label: "localcluster" },
      { host: "cloud-x", port: 6379, label: "cloud" },
      true,
    );
    expect(r).toContain("localcluster");
    expect(r).toContain("cloud");
    expect(r).toContain("INTERNAL_API_TOKEN");
  });
  it("uses a different hint when watcher is enabled (prior swap failed)", () => {
    const r = formatStaleReason(
      { host: "127.0.0.1", port: 12000, label: "localcluster" },
      { host: "cloud-x", port: 6379, label: "cloud" },
      false,
    );
    expect(r).toContain("prior swap failed");
  });
});
