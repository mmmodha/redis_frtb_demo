import { describe, it, expect, beforeEach } from "vitest";
import {
  getActiveTarget,
  setActiveTarget,
  resetActiveTarget,
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
      host: "demo-cluster.hsbc.internal",
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
