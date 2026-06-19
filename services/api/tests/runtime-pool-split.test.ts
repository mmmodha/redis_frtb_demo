// Wave 6.40.X — dedicated heavy-calc / heavy-ingest runtime Redis pools.
//
// The 2026-06-17 incident showed that a unified heavy pool let one wedged
// FT.AGGREGATE socket starve unrelated ingest writes (and vice-versa) because
// every API-side caller pulled from the same round-robin. This suite asserts
// the split: heavy-calc and heavy-ingest are physically independent pools
// sharing only the host/port/creds, the deprecated `"heavy"` label aliases
// to heavy-calc (with a one-shot warn), member IDs use the new prefix
// convention, and each pool's env-var chain resolves independently.
//
// The Redis factory is replaced with a stub that captures construction; no
// TCP sockets are opened.

import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getRuntimePoolForTests,
  __resetAliasWarnForTests,
  __setRuntimeClientFactoryForTests,
  getActiveRedisRuntimeClient,
  getPoolMemberInfo,
  getRuntimePoolSize,
  resetActiveTarget,
  setActiveTarget,
} from "../src/active-target.ts";

function makeFakeClient(commandTimeout: number): Redis {
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
    info: () => Promise.resolve(""),
    get: () => Promise.resolve(null),
    ping: () => Promise.resolve("PONG"),
  };
  return fake as unknown as Redis;
}

beforeEach(() => {
  resetActiveTarget();
  __resetAliasWarnForTests();
  delete process.env.REDIS_URL;
  delete process.env.RUNTIME_REDIS_COMMAND_TIMEOUT_MS;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_INGEST;
  delete process.env.RUNTIME_REDIS_POOL_SIZE_LIGHT;
  delete process.env.RUNTIME_REDIS_POOL_DRAIN_GRACE_MS;
  __setRuntimeClientFactoryForTests((_t, _c, opts) => makeFakeClient(opts.commandTimeout));
  setActiveTarget({ host: "split.example.com", port: 6379, tls: false, db: 0, label: "split" });
});

afterEach(() => {
  resetActiveTarget();
  __setRuntimeClientFactoryForTests(null);
});

describe("Wave 6.40.X — heavy-calc / heavy-ingest pool independence", () => {
  it("staling a heavy-calc member does NOT touch any heavy-ingest member", () => {
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy-calc");
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy-ingest");
    const calcSlot0 = __getRuntimePoolForTests("heavy-calc").members[0]!.client!;
    const ingestBefore = __getRuntimePoolForTests("heavy-ingest");
    (calcSlot0 as unknown as { emit: (e: string, p: unknown) => void })
      .emit("error", Object.assign(new Error("Command timed out"), {}));
    const ingestAfter = __getRuntimePoolForTests("heavy-ingest");
    // Every heavy-ingest slot must still hold its original client identity
    // and generation — a failure in heavy-calc has zero blast radius into
    // the heavy-ingest pool.
    for (let i = 0; i < 4; i++) {
      expect(ingestAfter.members[i]!.client).toBe(ingestBefore.members[i]!.client);
      expect(ingestAfter.members[i]!.generation).toBe(ingestBefore.members[i]!.generation);
    }
  });

  it("staling a heavy-ingest member does NOT touch any heavy-calc member", () => {
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy-calc");
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy-ingest");
    const ingestSlot0 = __getRuntimePoolForTests("heavy-ingest").members[0]!.client!;
    const calcBefore = __getRuntimePoolForTests("heavy-calc");
    (ingestSlot0 as unknown as { emit: (e: string, p: unknown) => void })
      .emit("error", Object.assign(new Error("Command timed out"), {}));
    const calcAfter = __getRuntimePoolForTests("heavy-calc");
    for (let i = 0; i < 4; i++) {
      expect(calcAfter.members[i]!.client).toBe(calcBefore.members[i]!.client);
      expect(calcAfter.members[i]!.generation).toBe(calcBefore.members[i]!.generation);
    }
  });

  it("member IDs follow the new prefix convention (heavy-calc:N / heavy-ingest:N)", () => {
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy-calc");
    for (let i = 0; i < 4; i++) getActiveRedisRuntimeClient("heavy-ingest");
    for (let i = 0; i < 4; i++) {
      expect(getPoolMemberInfo("heavy-calc", i)?.id).toBe(`heavy-calc:${i}`);
      expect(getPoolMemberInfo("heavy-ingest", i)?.id).toBe(`heavy-ingest:${i}`);
    }
  });
});

describe("Wave 6.40.X — deprecated 'heavy' alias", () => {
  it("aliases to heavy-calc (same pool, same member identities)", () => {
    const viaAlias = getActiveRedisRuntimeClient("heavy");
    const viaCanonical = getActiveRedisRuntimeClient("heavy-calc");
    expect(viaAlias).not.toBeNull();
    // Both routes land on the same heavy-calc pool — alias and canonical
    // are pointer-equivalent into the underlying member set.
    expect(__getRuntimePoolForTests("heavy").members.length)
      .toBe(__getRuntimePoolForTests("heavy-calc").members.length);
    expect(__getRuntimePoolForTests("heavy").members[0]?.client)
      .toBe(__getRuntimePoolForTests("heavy-calc").members[0]?.client);
    expect(viaCanonical).not.toBeNull();
  });

  it("aliased queries do NOT materialise the heavy-ingest pool", () => {
    getActiveRedisRuntimeClient("heavy");
    expect(__getRuntimePoolForTests("heavy-ingest").members.length).toBe(0);
  });

  it("emits exactly one structured pool-category-alias warn per process", () => {
    // The warn is gated off under NODE_ENV=test to keep vitest output clean;
    // flip the env for the duration of this test so the console.warn fires.
    const prevEnv = process.env.NODE_ENV;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      process.env.NODE_ENV = "production";
      __resetAliasWarnForTests();
      getActiveRedisRuntimeClient("heavy");
      getActiveRedisRuntimeClient("heavy");
      getActiveRedisRuntimeClient("heavy");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(warnSpy.mock.calls[0]![0]));
      expect(payload.evt).toBe("pool-category-alias");
      expect(payload.category).toBe("heavy");
      expect(payload.mapped_to).toBe("heavy-calc");
    } finally {
      warnSpy.mockRestore();
      process.env.NODE_ENV = prevEnv;
    }
  });
});

describe("Wave 6.40.X — env-var chains resolve per category", () => {
  it("heavy-calc reads RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC first, then falls back to legacy RUNTIME_REDIS_POOL_SIZE_HEAVY", () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC = "7";
    expect(getRuntimePoolSize("heavy-calc")).toBe(7);
    delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC;
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "5";
    expect(getRuntimePoolSize("heavy-calc")).toBe(5);
    delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY;
    expect(getRuntimePoolSize("heavy-calc")).toBe(4); // default
  });

  it("heavy-ingest reads RUNTIME_REDIS_POOL_SIZE_HEAVY_INGEST with default 4 (no legacy fallback)", () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_INGEST = "6";
    expect(getRuntimePoolSize("heavy-ingest")).toBe(6);
    delete process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_INGEST;
    // RUNTIME_REDIS_POOL_SIZE_HEAVY (legacy) must NOT influence heavy-ingest.
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY = "99";
    expect(getRuntimePoolSize("heavy-ingest")).toBe(4);
  });

  it("the deprecated 'heavy' alias resolves to the heavy-calc env chain", () => {
    process.env.RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC = "3";
    expect(getRuntimePoolSize("heavy")).toBe(3);
  });
});
