// Wave 6.30.B4 — fail-fast pool circuit breaker for stuck heavy connections.
//
// Background (2026-06-17 incident): on a fresh-boot api pointing at a large
// clustered target, `/calc/sbm/total` returned 500 "Command timed out" after 35s × 2 then 200 in
// 6ms on the 3rd attempt. Root cause: ioredis's default commandTimeout is 35s,
// and Wave 6.22's circuit breaker requires 3 consecutive failures — so one
// stuck pool member can burn ~105s of clock time before being skipped.
//
// This suite asserts Wave 6.30.B4:
//   * Option A — per-command timeout (5s heavy, 1.5s light by default) wrapped
//     around each pool dispatch so a stuck socket fails fast instead of
//     waiting on ioredis's 35s ceiling.
//   * Option C — fatal-error-pattern fast-trip: timeouts and "Stream isn't
//     writeable" trip the circuit on consecutive_failures=1 instead of 3.
//   * Scheduled half-open probe: once opened, a background timer fires after
//     `HALF_OPEN_INITIAL_BACKOFF_MS` to issue a single PING via the wrapper;
//     success closes the circuit, failure doubles backoff (capped at 5min).
//   * `pool-command-fail-fast` structured event distinct from
//     `pool-circuit-transition` / `pool-member-recycled`.
//
// All tests use the test-seam ioredis factory — no TCP sockets opened. Fake
// timers would obscure the wall-clock budget, so we use real timers with the
// per-command timeout configured to a small ms value via env override.

import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __getRuntimePoolForTests,
  __setPoolEventSinkForTests,
  __setRuntimeClientFactoryForTests,
  getActiveRedisRuntimeClient,
  resetActiveTarget,
  setActiveTarget,
  type PoolEventPayload,
} from "../src/active-target.ts";

// A pool member whose every command hangs forever — the stuck-socket fixture
// the task note explicitly calls for. `disconnect()` is a no-op (the recycle
// path calls it but we don't model the socket lifecycle here).
function stuckClient(): Redis {
  const listeners: Array<(err: unknown) => void> = [];
  const fake = {
    options: {},
    on(ev: string, fn: (err: unknown) => void): unknown { if (ev === "error") listeners.push(fn); return this; },
    emit(ev: string, p: unknown): void { if (ev === "error") for (const fn of listeners) fn(p); },
    disconnect(): void { /* no-op */ },
    ping: () => new Promise(() => { /* pending forever */ }),
    get: () => new Promise(() => { /* pending forever */ }),
    info: () => new Promise(() => { /* pending forever */ }),
  };
  return fake as unknown as Redis;
}

// A healthy pool member — every command resolves immediately. Used to verify
// round-robin routes around an open member.
function healthyClient(): Redis {
  const listeners: Array<(err: unknown) => void> = [];
  const fake = {
    options: {},
    on(ev: string, fn: (err: unknown) => void): unknown { if (ev === "error") listeners.push(fn); return this; },
    emit(ev: string, p: unknown): void { if (ev === "error") for (const fn of listeners) fn(p); },
    disconnect(): void { /* no-op */ },
    ping: () => Promise.resolve("PONG"),
    get: () => Promise.resolve(null),
    info: () => Promise.resolve(""),
  };
  return fake as unknown as Redis;
}

let capturedEvents: PoolEventPayload[];

beforeEach(() => {
  resetActiveTarget();
  delete process.env.REDIS_URL;
  delete process.env.RUNTIME_REDIS_COMMAND_TIMEOUT_MS;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_INGEST;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_LIGHT;
  delete process.env.RUNTIME_REDIS_POOL_DRAIN_GRACE_MS;
  delete process.env.POOL_MEMBER_FAILURE_THRESHOLD;
  delete process.env.CIRCUIT_BACKOFF_MS;
  delete process.env.POOL_COMMAND_TIMEOUT_HEAVY_MS;
  delete process.env.POOL_COMMAND_TIMEOUT_HEAVY_CALC_MS;
  delete process.env.POOL_COMMAND_TIMEOUT_HEAVY_INGEST_MS;
  delete process.env.POOL_COMMAND_TIMEOUT_LIGHT_MS;
  delete process.env.HALF_OPEN_INITIAL_BACKOFF_MS;
  delete process.env.HALF_OPEN_BACKOFF_CAP_MS;
  capturedEvents = [];
  __setPoolEventSinkForTests((p) => { capturedEvents.push(p); });
  setActiveTarget({ host: "ff.example.com", port: 6379, tls: false, db: 0, label: "ff" });
});

afterEach(() => {
  resetActiveTarget();
  __setRuntimeClientFactoryForTests(null);
  __setPoolEventSinkForTests(null);
});

describe("Wave 6.30.B4 — per-command timeout fail-fast", () => {
  it("three parallel stuck heavy dispatches each reject within the per-command timeout budget, not the 35s ioredis ceiling", async () => {
    // Per-command budget set tiny so we can run real-time without a 5s wait;
    // production default is 5_000ms (heavy) but the wiring is the same.
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "3";
    process.env.POOL_COMMAND_TIMEOUT_HEAVY_MS = "100";
    process.env.HALF_OPEN_INITIAL_BACKOFF_MS = "60000";
    __setRuntimeClientFactoryForTests(() => stuckClient());
    const t0 = Date.now();
    const results = await Promise.allSettled([
      (getActiveRedisRuntimeClient() as unknown as { ping: () => Promise<unknown> }).ping(),
      (getActiveRedisRuntimeClient() as unknown as { ping: () => Promise<unknown> }).ping(),
      (getActiveRedisRuntimeClient() as unknown as { ping: () => Promise<unknown> }).ping(),
    ]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect(((r as PromiseRejectedResult).reason as Error).message).toMatch(/pool-command-fail-fast/);
    }
    const ff = capturedEvents.filter((e) => e.evt === "pool-command-fail-fast");
    expect(ff.length).toBeGreaterThanOrEqual(3);
    expect(ff[0]!.category).toBe("heavy-calc");
  });

  it("a single fail-fast trips the circuit on consecutive_failures=1 (fatal error pattern)", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "1";
    process.env.POOL_COMMAND_TIMEOUT_HEAVY_MS = "50";
    // Baseline threshold stays at 3; the fatal-pattern overrides it down to 1.
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "3";
    process.env.HALF_OPEN_INITIAL_BACKOFF_MS = "60000";
    __setRuntimeClientFactoryForTests(() => stuckClient());
    const c = getActiveRedisRuntimeClient()!;
    await expect(
      (c as unknown as { ping: () => Promise<unknown> }).ping(),
    ).rejects.toThrow(/pool-command-fail-fast/);
    const snap = __getRuntimePoolForTests("heavy");
    expect(snap.members[0]!.circuitState).toBe("open");
    expect(snap.members[0]!.consecutiveFailures).toBe(1);
  });

  it("after one stuck member trips, subsequent acquisitions route to healthy peers", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "2";
    process.env.POOL_COMMAND_TIMEOUT_HEAVY_MS = "50";
    process.env.HALF_OPEN_INITIAL_BACKOFF_MS = "60000";
    let builds = 0;
    __setRuntimeClientFactoryForTests(() => (++builds === 1 ? stuckClient() : healthyClient()));
    const stuckW = getActiveRedisRuntimeClient()!;
    await expect(
      (stuckW as unknown as { ping: () => Promise<unknown> }).ping(),
    ).rejects.toThrow(/pool-command-fail-fast/);
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("open");
    const r1 = await (getActiveRedisRuntimeClient() as unknown as { ping: () => Promise<unknown> }).ping();
    const r2 = await (getActiveRedisRuntimeClient() as unknown as { ping: () => Promise<unknown> }).ping();
    const r3 = await (getActiveRedisRuntimeClient() as unknown as { ping: () => Promise<unknown> }).ping();
    expect([r1, r2, r3]).toEqual(["PONG", "PONG", "PONG"]);
  });

  it("scheduled half-open probe closes the circuit on success after the configured backoff", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "1";
    process.env.POOL_COMMAND_TIMEOUT_HEAVY_MS = "50";
    process.env.HALF_OPEN_INITIAL_BACKOFF_MS = "40";
    let builds = 0;
    __setRuntimeClientFactoryForTests(() => (++builds === 1 ? stuckClient() : healthyClient()));
    const w = getActiveRedisRuntimeClient()!;
    await expect(
      (w as unknown as { ping: () => Promise<unknown> }).ping(),
    ).rejects.toThrow(/pool-command-fail-fast/);
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("open");
    // Probe is scheduled for 40ms; allow generous slack for the wrapper's
    // healthy ping to resolve and noteSuccess to flip the circuit.
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("closed");
  });
});
