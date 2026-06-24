import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setActiveTarget,
  resetActiveTarget,
  onActiveTargetChange,
  getActiveRedisClient,
  type ActiveTarget,
} from "../src/active-target.ts";

describe("active-target — change notifications", () => {
  beforeEach(() => {
    resetActiveTarget();
    delete process.env.REDIS_URL;
  });

  it("fires registered listeners synchronously on setActiveTarget", () => {
    const seen: string[] = [];
    const off = onActiveTargetChange((t) => seen.push(t.label));
    setActiveTarget({ host: "h1", port: 1, tls: false, db: 0, label: "first" });
    setActiveTarget({ host: "h2", port: 2, tls: true, db: 0, label: "second" });
    expect(seen).toEqual(["first", "second"]);
    off();
  });

  it("returned unsubscribe function removes the listener", () => {
    const seen: string[] = [];
    const off = onActiveTargetChange((t) => seen.push(t.label));
    off();
    setActiveTarget({ host: "h", port: 1, tls: false, db: 0, label: "ignored" });
    expect(seen).toEqual([]);
  });

  it("strips extraneous fields (including password) before publishing", () => {
    const seen: ActiveTarget[] = [];
    onActiveTargetChange((t) => seen.push(t));
    setActiveTarget({
      host: "h", port: 1, tls: false, db: 0, label: "x",
      // @ts-expect-error — extras must be stripped
      password: "leaked",
    });
    expect((seen[0] as Record<string, unknown>).password).toBeUndefined();
  });
});

describe("getActiveRedisClient", () => {
  beforeEach(() => {
    resetActiveTarget();
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    resetActiveTarget();
  });

  it("returns null when there is no configured target", () => {
    const c = getActiveRedisClient();
    expect(c).toBeNull();
  });

  it("rebuilds the client when the active target changes", () => {
    setActiveTarget({ host: "10.0.0.1", port: 6379, tls: false, db: 0, label: "a" });
    const c1 = getActiveRedisClient();
    setActiveTarget({ host: "10.0.0.2", port: 6379, tls: false, db: 0, label: "b" });
    const c2 = getActiveRedisClient();
    expect(c2).not.toBe(c1);
    c1?.disconnect();
    c2?.disconnect();
  });

  it("returns the same instance for successive calls without a change", () => {
    setActiveTarget({ host: "10.0.0.1", port: 6379, tls: false, db: 0, label: "a" });
    const c1 = getActiveRedisClient();
    const c2 = getActiveRedisClient();
    expect(c2).toBe(c1);
    c1?.disconnect();
  });
});
