import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getActiveTarget,
  setActiveTarget,
  setActiveTargetLabel,
  resetActiveTarget,
  getActiveRedisClient,
  getActiveRedisRuntimeClient,
  onActiveTargetChange,
  __setRuntimeClientFactoryForTests,
  type ActiveTarget,
} from "../src/active-target.ts";
import type { Redis } from "ioredis";

describe("active-target singleton", () => {
  beforeEach(() => {
    resetActiveTarget();
    delete process.env.REDIS_URL;
  });

  it("falls back to REDIS_URL env when no active target set", () => {
    process.env.REDIS_URL = "redis://10.0.0.5:6380";
    const t = getActiveTarget();
    expect(t.host).toBe("10.0.0.5");
    expect(t.port).toBe(6380);
    expect(t.tls).toBe(false);
    expect(t.label).toBe("env:REDIS_URL");
  });

  it("supports rediss:// scheme for TLS", () => {
    process.env.REDIS_URL = "rediss://demo-cluster:6379";
    expect(getActiveTarget().tls).toBe(true);
  });

  it("defaults to localhost:6379 when no env and no override", () => {
    const t = getActiveTarget();
    expect(t.host).toBe("127.0.0.1");
    expect(t.port).toBe(6379);
    expect(t.label).toBe("default");
  });

  it("setActiveTarget overrides env and persists across calls", () => {
    process.env.REDIS_URL = "redis://envhost:6379";
    const override: ActiveTarget = {
      host: "demo-cluster.bank.internal",
      port: 12000,
      tls: true,
      db: 0,
      label: "demo-cluster",
    };
    setActiveTarget(override);
    expect(getActiveTarget()).toEqual(override);
  });

  it("never leaks password through getActiveTarget", () => {
    setActiveTarget({
      host: "h",
      port: 1,
      tls: false,
      db: 0,
      label: "x",
      // @ts-expect-error — password is intentionally not part of the public type
      password: "should-not-leak",
    });
    const t = getActiveTarget();
    expect((t as Record<string, unknown>).password).toBeUndefined();
  });
});

// Wave 5.16y — Test A: per-request getRedis() (via getActiveRedisClient)
// must construct the ioredis client with the stored username + password so
// authenticated targets (live-standalone with PW) don't return NOAUTH on
// /calc/sbm. We assert on the ioredis instance's `options` — those are what
// ioredis hands to the wire-protocol AUTH command, so an asserting test is
// equivalent to mocking the constructor.
describe("Wave 5.16y — getActiveRedisClient passes credentials to ioredis", () => {
  beforeEach(() => {
    resetActiveTarget();
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    resetActiveTarget();
  });

  it("includes username + password in the ioredis client options", () => {
    setActiveTarget(
      { host: "rs.example.com", port: 12000, tls: true, db: 0, label: "auth-target" },
      { username: "appuser", password: "PW-PASS" },
    );
    const c = getActiveRedisClient();
    expect(c).not.toBeNull();
    const opts = (c as unknown as { options: { username?: string; password?: string; host: string } }).options;
    expect(opts.host).toBe("rs.example.com");
    expect(opts.username).toBe("appuser");
    expect(opts.password).toBe("PW-PASS");
    c?.disconnect();
  });

  it("rebuilds the client when stored credentials change between activations", () => {
    setActiveTarget({ host: "h", port: 6379, tls: false, db: 0, label: "x" }, { password: "P1" });
    const c1 = getActiveRedisClient();
    setActiveTarget({ host: "h", port: 6379, tls: false, db: 0, label: "x" }, { password: "P2" });
    const c2 = getActiveRedisClient();
    expect(c2).not.toBe(c1);
    const o2 = (c2 as unknown as { options: { password?: string } }).options;
    expect(o2.password).toBe("P2");
    c1?.disconnect();
    c2?.disconnect();
  });

  it("omits username/password from the client when no creds are provided", () => {
    setActiveTarget({ host: "h", port: 6379, tls: false, db: 0, label: "no-auth" });
    const c = getActiveRedisClient();
    const opts = (c as unknown as { options: { username?: string; password?: string } }).options;
    // ioredis fills in defaults; an absent password is undefined (or empty
    // string in some versions) but never our prior call's value.
    expect(opts.password ?? "").toBe("");
    expect(opts.username ?? "default").toBe("default");
    c?.disconnect();
  });

  it("never exposes credentials via getActiveTarget()", () => {
    setActiveTarget(
      { host: "h", port: 1, tls: false, db: 0, label: "x" },
      { username: "u", password: "P" },
    );
    const t = getActiveTarget();
    expect((t as Record<string, unknown>).password).toBeUndefined();
    expect((t as Record<string, unknown>).username).toBeUndefined();
  });
});


// Wave 5.62 — setActiveTargetLabel is a presentation-only mutation used when
// the operator renames the active connection profile. It must update the label
// surfaced via GET /redis/active-target without bumping credsGeneration (no
// client rebuild needed) and without firing listeners (the bootstrap scheduler
// hangs off them — firing would re-trigger the "Bootstrapping…" banner).
describe("Wave 5.62 — setActiveTargetLabel", () => {
  beforeEach(() => {
    resetActiveTarget();
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    resetActiveTarget();
  });

  it("updates the label exposed by getActiveTarget()", () => {
    setActiveTarget({ host: "h", port: 6379, tls: false, db: 0, label: "old-name" });
    setActiveTargetLabel("new-name");
    expect(getActiveTarget().label).toBe("new-name");
  });

  it("does not rebuild the cached ioredis client (credsGeneration is unchanged)", () => {
    setActiveTarget(
      { host: "h", port: 6379, tls: false, db: 0, label: "old-name" },
      { password: "P" },
    );
    const c1 = getActiveRedisClient();
    setActiveTargetLabel("new-name");
    const c2 = getActiveRedisClient();
    // Same instance — the cache key embeds credsGeneration, so an unchanged
    // generation must yield a cache hit.
    expect(c2).toBe(c1);
    c1?.disconnect();
  });

  it("does not fire registered listeners", () => {
    setActiveTarget({ host: "h", port: 6379, tls: false, db: 0, label: "old-name" });
    let calls = 0;
    const unsub = onActiveTargetChange(() => { calls += 1; });
    setActiveTargetLabel("new-name");
    expect(calls).toBe(0);
    unsub();
  });

  it("is a no-op when no override is set (env fallback in use)", () => {
    process.env.REDIS_URL = "redis://envhost:6379";
    setActiveTargetLabel("attempted-rename");
    expect(getActiveTarget().label).toBe("env:REDIS_URL");
  });
});

// Wave 6.23 B2 — regression gate: the boot client (`getActiveRedisClient`)
// MUST keep ioredis's default retry budget and default offline queue, so a
// transient hiccup during bootstrap doesn't fail-stop the api before
// `withBootTimeout` makes the binding decision (Wave 6.18c invariant). Only
// the runtime pool members opt in to Wave 6.23 fast-fail
// (`maxRetriesPerRequest: 1` + `enableOfflineQueue: false`).
describe("Wave 6.23 — boot client retains default retry + offline queue (B2 regression)", () => {
  beforeEach(() => {
    resetActiveTarget();
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    resetActiveTarget();
  });

  it("boot client does NOT enable fast-fail (retry budget > 1, offline queue on)", () => {
    setActiveTarget(
      { host: "boot.example.com", port: 6379, tls: false, db: 0, label: "boot-target" },
    );
    const boot = getActiveRedisClient();
    expect(boot).not.toBeNull();
    const opts = (boot as unknown as { options: Record<string, unknown> }).options;
    // Boot-robustness invariant — the boot path must allow at least one
    // retry beyond the immediate failure (Wave 6.23 fast-fail sets this to
    // 1; any value > 1 OR the ioredis default proves the boot path opted
    // out). Asserting ">= 2" tolerates ioredis default changes (currently
    // 20) without coupling the test to a magic number.
    expect(typeof opts.maxRetriesPerRequest === "number" ? opts.maxRetriesPerRequest : 20)
      .toBeGreaterThanOrEqual(2);
    // The offline queue MUST stay enabled (ioredis default `true`); a Wave
    // 6.23 change that bled `enableOfflineQueue:false` into the boot path
    // would re-introduce the Wave 6.18c boot-fragility regression.
    expect(opts.enableOfflineQueue === undefined || opts.enableOfflineQueue === true).toBe(true);
    boot?.disconnect();
  });

  it("runtime pool client opts in to fast-fail (retry=1, offline queue off)", async () => {
    setActiveTarget(
      { host: "pool.example.com", port: 6379, tls: false, db: 0, label: "pool-target" },
    );
    // Wave 6.56.D4 — acquireFromPool now awaits awaitMemberReady before
    // returning, so we can't issue a real ioredis build against an unresolvable
    // host without a hang/throw. Verify the wiring by spying on the factory:
    // acquireFromPool MUST pass `fastFail: true` and the heavy commandTimeout,
    // which buildClient maps to `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`.
    let lastOpts: { commandTimeout: number; fastFail?: boolean } | null = null;
    __setRuntimeClientFactoryForTests((_t, _c, opts) => {
      lastOpts = opts;
      return { status: "ready", options: opts, on() { return this; }, disconnect() {} } as unknown as Redis;
    });
    try {
      await getActiveRedisRuntimeClient();
      expect(lastOpts).not.toBeNull();
      expect(lastOpts!.commandTimeout).toBe(35_000);
      expect(lastOpts!.fastFail).toBe(true);
    } finally {
      __setRuntimeClientFactoryForTests(null);
    }
  });
});
