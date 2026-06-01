import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getActiveTarget,
  setActiveTarget,
  resetActiveTarget,
  getActiveRedisClient,
  type ActiveTarget,
} from "../src/active-target.ts";

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
