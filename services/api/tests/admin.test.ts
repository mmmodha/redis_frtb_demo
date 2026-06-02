// Wave 5.38c — POST /admin/flush. Wipes the active Redis target via FLUSHDB
// and returns timing for the UI banner. 503 when no active target is set.

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { resetActiveTarget } from "../src/active-target.ts";

describe("POST /admin/flush", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
  });

  it("calls flushdb exactly once and returns ok + ms + target_label", async () => {
    const fr = fakeRedis();
    app = await createServer({
      redis: fr,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" },
    });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ms).toBe("number");
    expect(body.ms).toBeGreaterThanOrEqual(0);
    expect(body.target_label).toBe("redis-primary");

    const flushCalls = fr.calls.filter((c) => c.command === "FLUSHDB");
    expect(flushCalls).toHaveLength(1);
  });

  it("returns 503 when active target has no label", async () => {
    const fr = fakeRedis();
    app = await createServer({
      redis: fr,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "" },
    });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "no active target" });
    expect(fr.calls.find((c) => c.command === "FLUSHDB")).toBeUndefined();
  });

  it("surfaces translated redis errors (412 for missing index/library)", async () => {
    const fr = fakeRedis();
    fr.setFlushdbError(new Error("Unknown Index name"));
    app = await createServer({
      redis: fr,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "redis-primary" },
    });
    const res = await app.inject({ method: "POST", url: "/admin/flush" });
    expect(res.statusCode).toBe(412);
    expect(res.json().target_label).toBe("redis-primary");
  });
});
