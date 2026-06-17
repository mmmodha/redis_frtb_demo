// Wave 6.18c boot-timeout regression gate.
//
// Simulates a wedged Redis socket whose first command never resolves (mock
// `bootstrapFrtb` returns a never-settling Promise). Asserts the boot path
// still binds the listener within the budget and surfaces a `failed`
// bootstrap status with the timeout error — i.e. `app.listen(...)` is no
// longer reachable only after a hung Redis call resolves.
//
// Companion to Wave 6.18a (TCP keepAlive) and the connectTimeout +
// commandTimeout added to the ioredis factories in this wave.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenSpy = vi.fn(async () => undefined);
const closeSpy = vi.fn(async () => undefined);
// Default /healthz handler — liveness probe is unconditional 200 in
// production (services/api/src/server.ts), so the captured app's `inject`
// returns the same shape regardless of bootstrap state.
const injectSpy = vi.fn(async (_opts: { method: string; url: string }) => ({
  statusCode: 200,
  payload: JSON.stringify({ service: "api", status: "alive" }),
}));

vi.mock("../src/store.ts", () => ({
  createStore: vi.fn(async () => ({
    getActiveRaw: () => undefined,
    list: async () => [],
    setActive: async () => null,
  })),
}));

vi.mock("../src/seed.ts", () => ({
  seedConnections: vi.fn(async () => undefined),
}));

vi.mock("../src/bootstrap.ts", () => ({
  // Never-settling Promise — mimics the VM symptom (ep_poll, 87B in send-q
  // to redis-12000) where a single Redis command silently never returns.
  bootstrapFrtb: vi.fn(() => new Promise(() => { /* never resolves */ })),
  BootstrapPartialError: class BootstrapPartialError extends Error {
    failures: unknown[] = [];
  },
}));

vi.mock("../src/redis-ready.ts", () => ({
  ensureRedisReady: vi.fn(async () => ({ connected: true, mode: "standalone" })),
}));

vi.mock("@frtb/redis-client", () => ({
  createRedisClient: vi.fn(() => ({
    quit: vi.fn(async () => undefined),
  })),
}));

// Return a non-undefined schema so the boot path takes the
// `redisConnected && schema` bootstrap branch (where the timeout wrapper lives).
vi.mock("@frtb/schema", () => ({
  loadSchema: vi.fn(() => ({ riskClasses: {}, buckets: {} })),
}));

vi.mock("../src/sbm/correlations.ts", () => ({
  buildCrossBucketCorrelations: vi.fn(() => ({})),
}));

vi.mock("../src/server.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/server.ts")>(
    "../src/server.ts",
  );
  return {
    ...actual,
    createServer: vi.fn(async () => ({
      listen: listenSpy,
      close: closeSpy,
      inject: injectSpy,
    })),
  };
});

describe("Wave 6.18c — boot timeout: hung bootstrapFrtb does not block app.listen", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.FRTB_MASTER_KEY = "boot-timeout-test-key";
    // Shrink the boot-timeout to keep the test fast — still far longer than
    // the microtask flush below, so the timeout fires after the bootstrap
    // branch starts and before any assertion.
    process.env.API_BOOT_BOOTSTRAP_TIMEOUT_MS = "150";
    process.env.SMOKE = "1"; // exit-spy intercepts process.exit
    delete process.env.REDIS_URL;
    listenSpy.mockClear();
    closeSpy.mockClear();
    injectSpy.mockClear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.env = originalEnv;
    vi.resetModules();
  });

  it("listen() runs within 15s, bootstrap-status=failed, /healthz=200", async () => {
    const t0 = Date.now();
    await import("../src/index.ts");

    // Wait for the timeout to fire and the boot path to reach app.listen.
    // Poll up to 15 000 ms (the DoD budget) rather than blocking on a single
    // long timer so a regression (timeout never fires) surfaces as a failed
    // assertion rather than a vitest-killed run.
    const deadline = t0 + 15_000;
    while (listenSpy.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const elapsed = Date.now() - t0;

    expect(listenSpy).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(15_000);

    const { getBootstrapStatus } = await import("../src/bootstrap-status.ts");
    const status = getBootstrapStatus();
    expect(status.phase).toBe("failed");
    expect(status.err).toMatch(/boot-timeout: bootstrapFrtb/);

    const res = await injectSpy({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);

    const fatalCalls = errorSpy.mock.calls.filter((call) => {
      const arg = call[0];
      return typeof arg === "string" && arg.includes('"status":"fatal"');
    });
    expect(fatalCalls).toEqual([]);
  });
});
