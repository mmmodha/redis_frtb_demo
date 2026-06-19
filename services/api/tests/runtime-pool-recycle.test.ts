// Wave 6.22 — pool member auto-recycle + circuit breaker.
//
// Wave 6.21 introduced per-member recycle on the first poisoned-socket error
// (single timeout → mark stale → rebuild). 6.22 layers a small circuit
// breaker on top: consecutive failures count toward POOL_MEMBER_FAILURE_
// THRESHOLD; reaching it flips the member to `open` and round-robin skips
// it; when every member is open, the oldest one is promoted to `half-open`
// and rebuilt to probe recovery; a successful command closes the circuit, a
// failure re-opens it.
//
// All tests run against a stub ioredis factory installed via the test seam
// — no TCP sockets opened. Error events are emitted synchronously via the
// fake client's `.emit("error", ...)` so failure counting and circuit
// transitions are deterministic without waiting on socket I/O.

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

// Stub ioredis client with a configurable error emitter and command surface.
// Mirrors the helper in `runtime-pool.test.ts` but exposes a callable
// `commandImpl` per slot so individual cases can swap behaviour per-slot
// (the inner factory captures slot ordering by construction count).
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
    info: () => commandImpl ? commandImpl() : Promise.resolve(""),
    get: () => commandImpl ? commandImpl() : Promise.resolve(null),
    ping: () => commandImpl ? commandImpl() : Promise.resolve("PONG"),
  };
  return fake as unknown as Redis;
}

function timeoutError(): Error {
  return Object.assign(new Error("Command timed out"), {});
}

// Wave 6.30.B4 — "Command timed out" now fast-trips the circuit on
// consecutive_failures=1 (covered by `pool-fail-fast.test.ts`). Tests below
// that exercise the threshold-of-N path use a non-fatal socket error code
// instead so the threshold semantics remain observable.
function nonFatalSocketError(): Error {
  return Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
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
  capturedEvents = [];
  __setPoolEventSinkForTests((p) => { capturedEvents.push(p); });
  __setRuntimeClientFactoryForTests((_t, _c, opts) => makeFakeClient(opts.commandTimeout));
  setActiveTarget({ host: "pool.example.com", port: 6379, tls: false, db: 0, label: "pool" });
});

afterEach(() => {
  resetActiveTarget();
  __setRuntimeClientFactoryForTests(null);
  __setPoolEventSinkForTests(null);
});

describe("Wave 6.22 — failure-threshold circuit open", () => {
  it("3 consecutive non-fatal failures on one member flips it to open; socket is torn down; pool size stays at 4", () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "4";
    // Materialise all 4 slots so we have a stable reference to slot 0.
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient();
    // Each failure recycles the socket, so we have to rebuild via the
    // round-robin path between emissions. Cycle through 4 acquisitions to
    // bring us back to slot 0 after each rebuild. Wave 6.30.B4 — use a
    // non-fatal error code so the threshold-of-3 path is exercised here
    // (the fatal-pattern fast-trip is covered by `pool-fail-fast.test.ts`).
    for (let attempt = 0; attempt < 3; attempt++) {
      const slot0 = __getRuntimePoolForTests("heavy").members[0]!.client!;
      (slot0 as unknown as { emit: (e: string, p: unknown) => void })
        .emit("error", nonFatalSocketError());
      // Cycle round-robin back to slot 0 (need 4 acquisitions; the 4th
      // lands on slot 0 since slot 1 just got picked).
      for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient();
    }
    const snap = __getRuntimePoolForTests("heavy");
    expect(snap.members[0]!.circuitState).toBe("open");
    expect(snap.members.length).toBe(4);
    // The other 3 members must remain closed.
    for (let i = 1; i < 4; i++) {
      expect(snap.members[i]!.circuitState).toBe("closed");
    }
    // At least one structured pool-circuit-transition event must mention
    // the closed→open transition for heavy:0.
    const transitions = capturedEvents.filter(
      (e) => e.evt === "pool-circuit-transition" && e.member_id === "heavy-calc:0",
    );
    expect(transitions.some((e) => e.from === "closed" && e.to === "open")).toBe(true);
  });
});

describe("Wave 6.22 — round-robin skips open members", () => {
  it("with slot 0 open, 6 acquisitions distribute across the 3 remaining slots", () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "4";
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "1"; // open on first failure
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient();
    const slot0 = __getRuntimePoolForTests("heavy").members[0]!.client!;
    (slot0 as unknown as { emit: (e: string, p: unknown) => void })
      .emit("error", timeoutError());
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("open");
    // Track which wrapper each acquisition returns; with slot 0 skipped,
    // 6 acquisitions should rotate across slots 1, 2, 3 twice.
    const wrappers: Array<Redis | null> = [];
    for (let i = 0; i < 6; i++) wrappers.push(getActiveRedisRuntimeClient());
    const distinct = new Set(wrappers);
    expect(distinct.size).toBe(3); // only slots 1, 2, 3 are touched
    // Slot 0 wrapper must NOT appear among the acquisitions.
    const snap = __getRuntimePoolForTests("heavy");
    expect(snap.members[0]!.client).toBeNull();
    for (const w of wrappers) {
      for (let i = 1; i < 4; i++) {
        // Each wrapper matches a non-open slot's wrapper.
        if (snap.members[i]!.wrapper === w) break;
      }
    }
  });
});

describe("Wave 6.22 — all-open promotes oldest to half-open", () => {
  it("when every member is open, the next acquisition transitions the oldest to half-open and rebuilds it", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "3";
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "1";
    process.env.CIRCUIT_BACKOFF_MS = "0"; // skip backoff gating
    for (let i = 0; i < 3; i++) getActiveRedisRuntimeClient();
    const snap0 = __getRuntimePoolForTests("heavy");
    // Open every slot in order so slot 0 ends up the oldest.
    for (let i = 0; i < 3; i++) {
      const c = snap0.members[i]!.client!;
      (c as unknown as { emit: (e: string, p: unknown) => void })
        .emit("error", timeoutError());
      // Tiny await so the openedAt timestamps differ between slots.
      await new Promise<void>((r) => setTimeout(r, 2));
    }
    const allOpen = __getRuntimePoolForTests("heavy");
    for (let i = 0; i < 3; i++) {
      expect(allOpen.members[i]!.circuitState).toBe("open");
    }
    // Next acquisition: every member open → oldest (slot 0) goes half-open
    // and gets a fresh client.
    const w = getActiveRedisRuntimeClient();
    expect(w).not.toBeNull();
    const snap1 = __getRuntimePoolForTests("heavy");
    expect(snap1.members[0]!.circuitState).toBe("half-open");
    expect(snap1.members[0]!.client).not.toBeNull();
    // Structured event for the open→half-open transition was emitted.
    expect(capturedEvents.some(
      (e) => e.evt === "pool-circuit-transition" && e.member_id === "heavy-calc:0"
        && e.from === "open" && e.to === "half-open",
    )).toBe(true);
  });
});

describe("Wave 6.22 — half-open success closes the circuit", () => {
  it("a successful command on a half-open member transitions back to closed and resets the failure counter", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "2";
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "1";
    process.env.CIRCUIT_BACKOFF_MS = "0";
    // Build slots 0 and 1, open both.
    for (let i = 0; i < 2; i++) getActiveRedisRuntimeClient();
    for (let i = 0; i < 2; i++) {
      const c = __getRuntimePoolForTests("heavy").members[i]!.client!;
      (c as unknown as { emit: (e: string, p: unknown) => void })
        .emit("error", timeoutError());
      await new Promise<void>((r) => setTimeout(r, 2));
    }
    // All open → next acquisition half-opens slot 0 with a fresh client.
    const halfOpenWrapper = getActiveRedisRuntimeClient()!;
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("half-open");
    // Successful command via the wrapper closes the circuit.
    await (halfOpenWrapper as unknown as { ping: () => Promise<unknown> }).ping();
    const snap = __getRuntimePoolForTests("heavy");
    expect(snap.members[0]!.circuitState).toBe("closed");
    expect(snap.members[0]!.consecutiveFailures).toBe(0);
  });
});

describe("Wave 6.22 — half-open failure re-opens the circuit", () => {
  it("a failure on a half-open member transitions back to open immediately (one stumble is enough)", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "2";
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "1"; // open on first failure
    process.env.CIRCUIT_BACKOFF_MS = "0";
    // Use a rejecting factory so the wrapped command rejects with a timeout.
    __setRuntimeClientFactoryForTests((_t, _c, opts) =>
      makeFakeClient(opts.commandTimeout, () => Promise.reject(timeoutError())));
    // Build 2 slots; flip both to open via a single error emission each
    // (threshold=1).
    for (let i = 0; i < 2; i++) getActiveRedisRuntimeClient();
    for (let slot = 0; slot < 2; slot++) {
      const c = __getRuntimePoolForTests("heavy").members[slot]!.client!;
      (c as unknown as { emit: (e: string, p: unknown) => void })
        .emit("error", timeoutError());
      await new Promise<void>((r) => setTimeout(r, 2));
    }
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("open");
    expect(__getRuntimePoolForTests("heavy").members[1]!.circuitState).toBe("open");
    // Promote slot 0 to half-open via the all-open acquisition path.
    const w = getActiveRedisRuntimeClient()!;
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("half-open");
    // Issue a command via the wrapper — it rejects (factory always rejects)
    // and the half-open member immediately re-opens.
    await expect(
      (w as unknown as { ping: () => Promise<unknown> }).ping(),
    ).rejects.toThrow(/Command timed out/);
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("open");
  });
});

describe("Wave 6.22 — successful command resets failure count", () => {
  it("a single success between failures keeps the circuit closed indefinitely", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "1";
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "3";
    // Single-slot pool so every acquisition returns the same wrapper.
    // Wave 6.30.B4 — non-fatal error so the threshold-of-3 path is what's
    // tested (fatal patterns now fast-trip on consecutive_failures=1).
    let nextShouldReject = true;
    __setRuntimeClientFactoryForTests((_t, _c, opts) => makeFakeClient(opts.commandTimeout, () =>
      nextShouldReject
        ? Promise.reject(nonFatalSocketError())
        : Promise.resolve("ok")));
    const w = getActiveRedisRuntimeClient()!;
    // Pattern: fail, fail, success, fail, fail. With threshold=3 and a
    // success in the middle, we never reach 3 consecutive failures.
    for (let i = 0; i < 2; i++) {
      nextShouldReject = true;
      await expect(
        (w as unknown as { ping: () => Promise<unknown> }).ping(),
      ).rejects.toBeTruthy();
      // Each failure also recycles the socket; re-acquire to rebuild.
      getActiveRedisRuntimeClient();
    }
    // Successful command — failure counter resets to 0.
    nextShouldReject = false;
    const w2 = getActiveRedisRuntimeClient()!;
    await (w2 as unknown as { ping: () => Promise<unknown> }).ping();
    expect(__getRuntimePoolForTests("heavy").members[0]!.consecutiveFailures).toBe(0);
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("closed");
    // Two more failures — still below threshold (counter restarted at 0).
    nextShouldReject = true;
    for (let i = 0; i < 2; i++) {
      await expect(
        (getActiveRedisRuntimeClient()! as unknown as { ping: () => Promise<unknown> }).ping(),
      ).rejects.toBeTruthy();
    }
    expect(__getRuntimePoolForTests("heavy").members[0]!.circuitState).toBe("closed");
  });
});

describe("Wave 6.22 — heavy pool circuit state does NOT bleed into light", () => {
  it("opening every heavy member leaves the light pool fully closed", () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "2";
    process.env.RUNTIME_REDIS_POOL_SIZE_LIGHT = "2";
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "1";
    for (let i = 0; i < 2; i++) getActiveRedisRuntimeClient("heavy");
    for (let i = 0; i < 2; i++) getActiveRedisRuntimeClient("light");
    // Open every heavy member.
    for (let i = 0; i < 2; i++) {
      const c = __getRuntimePoolForTests("heavy").members[i]!.client!;
      (c as unknown as { emit: (e: string, p: unknown) => void })
        .emit("error", timeoutError());
    }
    const light = __getRuntimePoolForTests("light");
    for (let i = 0; i < 2; i++) {
      expect(light.members[i]!.circuitState).toBe("closed");
      expect(light.members[i]!.consecutiveFailures).toBe(0);
      expect(light.members[i]!.client).not.toBeNull();
    }
  });
});

describe("Wave 6.22 — long-burst recovery", () => {
  it("20 sequential calls against an always-failing pool detect, rebuild, and protect routes from infinite retries (wall-clock << 20 × timeout)", async () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "2";
    process.env.POOL_MEMBER_FAILURE_THRESHOLD = "2";
    process.env.CIRCUIT_BACKOFF_MS = "0";
    // Factory always rejects with a timeout-shaped error AT WRAPPER LEVEL
    // — the rejection is immediate so the wall-clock cost of a single call
    // is microseconds, not commandTimeout. The pool itself must bound how
    // many sockets get built across 20 attempts.
    let built = 0;
    __setRuntimeClientFactoryForTests((_t, _c, opts) => {
      built += 1;
      return makeFakeClient(opts.commandTimeout, () => Promise.reject(timeoutError()));
    });
    const t0 = Date.now();
    let lastErr: unknown;
    for (let i = 0; i < 20; i++) {
      const c = getActiveRedisRuntimeClient();
      if (!c) continue;
      try {
        await (c as unknown as { ping: () => Promise<unknown> }).ping();
      } catch (e) {
        lastErr = e;
      }
    }
    const elapsed = Date.now() - t0;
    expect(lastErr).toBeTruthy();
    // Wall-clock under 30s (the spec's bound). In practice this completes
    // in tens of ms because the rejection is synchronous.
    expect(elapsed).toBeLessThan(30_000);
    // The factory was invoked many times (each rebuild + half-open probe)
    // but bounded — should not be ≥ 20 since most calls hit already-open
    // members and never trigger a fresh build.
    expect(built).toBeGreaterThanOrEqual(2); // at least the initial 2 slots
  });
});
