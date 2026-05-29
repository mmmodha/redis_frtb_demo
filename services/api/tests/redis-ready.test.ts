import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Cluster, Redis } from "ioredis";
import { ensureRedisReady } from "../src/redis-ready.ts";

// Wave 5.15r — dispatch now keys off an explicit `cluster` flag (not URL
// presence), so a standalone client with a REDIS_URL routes to the .connect()
// branch instead of timing out waiting for a 'ready' event that never fires.
// Wave 5.8.1 — locks in the connect-or-bootstrap gate for both shapes:
//   - cluster=true: wait for 'ready' with a bounded timeout, never call
//     .connect()
//   - cluster=false: call .connect() and tolerate the auto-connect
//     "already connecting/connected" error as success.

class FakeCluster extends EventEmitter {
  public status: string = "connecting";
  fireReady(): void { this.status = "ready"; this.emit("ready"); }
  fireError(err: Error): void { this.emit("error", err); }
}

describe("ensureRedisReady — cluster path", () => {
  it("returns connected:true immediately when status is already 'ready'", async () => {
    const c = new FakeCluster();
    c.status = "ready";
    const r = await ensureRedisReady(c as unknown as Cluster, { cluster: true, timeoutMs: 5_000 });
    expect(r).toEqual({ connected: true, mode: "cluster" });
  });

  it("resolves connected:true once 'ready' fires", async () => {
    const c = new FakeCluster();
    const p = ensureRedisReady(c as unknown as Cluster, { cluster: true, timeoutMs: 5_000 });
    setTimeout(() => c.fireReady(), 5);
    await expect(p).resolves.toEqual({ connected: true, mode: "cluster" });
  });

  it("resolves connected:false on 'error' event without throwing", async () => {
    const c = new FakeCluster();
    const p = ensureRedisReady(c as unknown as Cluster, { cluster: true, timeoutMs: 5_000 });
    setTimeout(() => c.fireError(new Error("CLUSTERDOWN")), 5);
    const r = await p;
    expect(r.connected).toBe(false);
    expect(r.mode).toBe("cluster");
    expect(String(r.err)).toMatch(/CLUSTERDOWN/);
  });

  it("resolves connected:false on timeout when neither 'ready' nor 'error' fires", async () => {
    const c = new FakeCluster();
    const r = await ensureRedisReady(c as unknown as Cluster, { cluster: true, timeoutMs: 30 });
    expect(r.connected).toBe(false);
    expect(r.mode).toBe("cluster");
    expect(String(r.err)).toMatch(/timeout/i);
  });

  it("does not call .connect() on a Cluster", async () => {
    const c = new FakeCluster() as unknown as Cluster & { connect: unknown };
    const connectSpy = vi.fn();
    (c as unknown as { connect: typeof connectSpy }).connect = connectSpy;
    const p = ensureRedisReady(c, { cluster: true, timeoutMs: 5_000 });
    setTimeout(() => (c as unknown as FakeCluster).fireReady(), 5);
    await p;
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe("ensureRedisReady — standalone path", () => {
  it("calls .connect() and reports connected:true on success", async () => {
    const stub = { connect: vi.fn().mockResolvedValue(undefined) };
    const r = await ensureRedisReady(stub as unknown as Redis, { cluster: false });
    expect(r).toEqual({ connected: true, mode: "standalone" });
    expect(stub.connect).toHaveBeenCalledTimes(1);
  });

  it("tolerates 'already connecting/connected' as a no-op success", async () => {
    const stub = {
      connect: vi.fn().mockRejectedValue(new Error("Redis is already connecting/connected")),
    };
    const r = await ensureRedisReady(stub as unknown as Redis, { cluster: false });
    expect(r).toEqual({ connected: true, mode: "standalone" });
  });

  it("returns connected:false on other connect errors (no throw)", async () => {
    const stub = {
      connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:6379")),
    };
    const r = await ensureRedisReady(stub as unknown as Redis, { cluster: false });
    expect(r.connected).toBe(false);
    expect(r.mode).toBe("standalone");
    expect(String(r.err)).toMatch(/ECONNREFUSED/);
  });

  // Wave 5.15r regression: a standalone client built from a REDIS_URL must
  // still route through .connect() — not the cluster 'ready'-event wait.
  it("with cluster=false + lazyConnect, calls .connect() (no 'ready' wait)", async () => {
    const c = new FakeCluster() as unknown as Redis & { connect: unknown };
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    (c as unknown as { connect: typeof connectSpy }).connect = connectSpy;
    const r = await ensureRedisReady(c, { cluster: false, timeoutMs: 5_000 });
    expect(r).toEqual({ connected: true, mode: "standalone" });
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

// Mirror the index.ts gate so the DoD "ready → bootstrap once" and
// "error → no bootstrap, no throw" contracts are locked in against future
// refactors of the startup block.
describe("startup gate — cluster readiness ↔ bootstrapFrtb", () => {
  it("invokes bootstrap exactly once when Cluster fires 'ready'", async () => {
    const c = new FakeCluster();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const schema = { risk_classes: [] } as unknown;

    const p = (async () => {
      const r = await ensureRedisReady(c as unknown as Cluster, { cluster: true, timeoutMs: 5_000 });
      if (r.connected && schema) await bootstrap(c, schema);
      return r;
    })();
    setTimeout(() => c.fireReady(), 5);
    const r = await p;

    expect(r.connected).toBe(true);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke bootstrap and does NOT throw when Cluster fires 'error'", async () => {
    const c = new FakeCluster();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const schema = { risk_classes: [] } as unknown;
    let redisConnected = false;
    let threw = false;

    const run = (async () => {
      try {
        const r = await ensureRedisReady(c as unknown as Cluster, { cluster: true, timeoutMs: 5_000 });
        redisConnected = r.connected;
        if (r.connected && schema) await bootstrap(c, schema);
        return r;
      } catch {
        threw = true;
        return { connected: false, mode: "cluster" as const };
      }
    })();
    setTimeout(() => c.fireError(new Error("ENOTFOUND seed.example")), 5);
    const r = await run;

    expect(threw).toBe(false);
    expect(r.connected).toBe(false);
    expect(redisConnected).toBe(false);
    expect(bootstrap).not.toHaveBeenCalled();
  });
});
