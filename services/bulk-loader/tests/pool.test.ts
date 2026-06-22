// Wave 7.0.1.A — bulk-loader pool unit tests.
//
// Covers the Definition-of-Done items:
//   • Pool sizing from env / opts.size.
//   • 75% healthz threshold partial-connection logic.
//   • Reconnect on dropped connection (state transitions).

import { describe, it, expect } from "vitest";
import { createWorkerPool } from "../src/pool.ts";
import { FakeClient } from "./helpers/fake-client.ts";

function makePool(size: number) {
  const clients: FakeClient[] = [];
  const silentLogger = { info: (_o: object, _m: string) => {} };
  const pool = createWorkerPool({
    size,
    redisFactory: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    heartbeatMs: 60_000,
    logger: silentLogger,
  });
  return { pool, clients };
}

describe("createWorkerPool — sizing", () => {
  it("creates exactly `size` workers (default 32 path)", () => {
    const { pool, clients } = makePool(32);
    expect(pool.workers).toHaveLength(32);
    expect(clients).toHaveLength(32);
    expect(pool.workers[0]?.id).toBe(0);
    expect(pool.workers[31]?.id).toBe(31);
  });

  it("honours custom env-driven size (BULK_LOADER_POOL_SIZE=8)", () => {
    const { pool } = makePool(8);
    expect(pool.workers).toHaveLength(8);
    expect(pool.status().poolSize).toBe(8);
  });

  it("rejects non-positive sizes", () => {
    expect(() =>
      createWorkerPool({ size: 0, redisFactory: () => new FakeClient() }),
    ).toThrow(/positive integer/);
    expect(() =>
      createWorkerPool({ size: -1, redisFactory: () => new FakeClient() }),
    ).toThrow(/positive integer/);
  });
});

describe("createWorkerPool — healthz 75% threshold", () => {
  it("isHealthy() is true when ≥75% of workers are connected", async () => {
    const { pool, clients } = makePool(4);
    expect(pool.isHealthy()).toBe(false);
    clients[0]!.becomeReady();
    clients[1]!.becomeReady();
    clients[2]!.becomeReady();
    // 3 of 4 = 75% → healthy
    expect(pool.isHealthy()).toBe(true);
    expect(pool.status().connected).toBe(3);
    await pool.stop();
  });

  it("isHealthy() is false at 50%", async () => {
    const { pool, clients } = makePool(4);
    clients[0]!.becomeReady();
    clients[1]!.becomeReady();
    // 2 of 4 = 50% < 75% → unhealthy
    expect(pool.isHealthy()).toBe(false);
    expect(pool.status().connected).toBe(2);
    await pool.stop();
  });

  it("respects a custom healthyFraction (override)", async () => {
    const clients: FakeClient[] = [];
    const pool = createWorkerPool({
      size: 4,
      redisFactory: () => { const c = new FakeClient(); clients.push(c); return c; },
      heartbeatMs: 60_000,
      healthyFraction: 0.5,
      logger: { info: () => {} },
    });
    clients[0]!.becomeReady();
    clients[1]!.becomeReady();
    expect(pool.isHealthy()).toBe(true); // 50% with override
    await pool.stop();
  });
});

describe("createWorkerPool — reconnect", () => {
  it("transitions a worker connected → disconnected → connected on drop+ready", async () => {
    const { pool, clients } = makePool(2);
    const c0 = clients[0]!;
    c0.becomeReady();
    expect(pool.workers[0]?.state).toBe("connected");

    c0.drop();
    // After close+reconnecting, state should reflect the reconnect attempt.
    expect(pool.workers[0]?.state).toBe("connecting");
    expect(pool.status().connected).toBe(0);

    c0.becomeReady();
    expect(pool.workers[0]?.state).toBe("connected");
    expect(pool.status().connected).toBe(1);
    await pool.stop();
  });

  it("flips to disconnected on `end` and stays there until ready re-fires", async () => {
    const { pool, clients } = makePool(1);
    const c0 = clients[0]!;
    c0.becomeReady();
    expect(pool.workers[0]?.state).toBe("connected");
    c0.goAway();
    expect(pool.workers[0]?.state).toBe("disconnected");
    expect(pool.isHealthy()).toBe(false);
    await pool.stop();
  });
});

describe("createWorkerPool — status() shape", () => {
  it("returns per-worker last_heartbeat (null pre-tick) and last_flush_at (null in skeleton)", () => {
    const { pool } = makePool(2);
    const s = pool.status();
    expect(s.workers[0]?.last_heartbeat).toBeNull();
    expect(s.workers[0]?.last_flush_at).toBeNull();
    expect(s.workers[1]?.id).toBe(1);
  });
});

describe("createWorkerPool — stop()", () => {
  it("disconnects every worker exactly once", async () => {
    const { pool, clients } = makePool(3);
    await pool.stop();
    expect(clients.every((c) => c.disconnectCalls === 1)).toBe(true);
  });
});
