// Wave 6.18a — boot-ordering regression gate.
//
// `setActiveTarget(...)` runs in main() BEFORE `createServer` registers the
// onActiveTargetChange listener that hangs scheduleBootstrap off
// profile-switches. A persisted active target therefore restored without
// triggering scheduleBootstrap, leaving the listener-driven phase tracker
// untouched. The fix in index.ts fires one scheduleBootstrap AFTER
// createServer returns; this test pins that contract by observing the
// scheduleBootstrap-driven side-effect (a runner invocation against the
// persisted target's identity) rather than spying on the export directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/store.ts", () => ({
  createStore: vi.fn(async () => ({
    getActiveRaw: () => ({
      host: "persisted.example.com",
      port: 6379,
      tls: { enabled: false },
      db: 0,
      name: "persisted-profile",
      clusterMode: false,
    }),
    list: async () => [],
    setActive: async () => null,
  })),
}));

vi.mock("../src/seed.ts", () => ({
  seedConnections: vi.fn(async () => undefined),
}));

vi.mock("../src/bootstrap.ts", () => ({
  bootstrapFrtb: vi.fn(async () => undefined),
  BootstrapPartialError: class BootstrapPartialError extends Error {
    failures: unknown[];
    constructor(failures: unknown[]) {
      super("partial");
      this.failures = failures;
    }
  },
}));

vi.mock("../src/redis-ready.ts", () => ({
  ensureRedisReady: vi.fn(async () => ({
    connected: false,
    err: new Error("boot-ordering: redis unreachable (mocked)"),
  })),
}));

vi.mock("@frtb/redis-client", () => ({
  createRedisClient: vi.fn(() => ({
    quit: vi.fn(async () => undefined),
  })),
}));

// loadSchema returns a truthy stub so scheduleBootstrap doesn't early-exit
// on `!schema`. The stub satisfies buildCrossBucketCorrelations's
// `Object.entries(schema.risk_classes)` (empty map is fine); the boot-time
// `bootstrapFrtb` path is gated off by `redisConnected: false` above so the
// stub never reaches frtb logic.
vi.mock("@frtb/schema", () => ({
  loadSchema: vi.fn(() => ({ risk_classes: {}, correlations: {} })),
}));

describe("boot ordering: persisted active target triggers scheduleBootstrap after createServer", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.FRTB_MASTER_KEY = "boot-ordering-test-key";
    process.env.SMOKE = "1";
    process.env.API_PORT = "0";
    delete process.env.REDIS_URL;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    errorSpy = vi.spyOn(console, "error");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.env = originalEnv;
    vi.resetModules();
  });

  it("fires scheduleBootstrap once for the restored target after createServer returns", async () => {
    const status = await import("../src/bootstrap-status.ts");
    status.resetBootstrapStatusForTests();
    status.setDebounceMsForTests(1);
    const runner = vi.fn(async () => undefined);
    status.setBootstrapRunnerForTests(runner);

    await import("../src/index.ts");

    // Allow main() to finish its await chain (cors register, ioredis import,
    // ensureRedisReady, createServer, scheduleBootstrap, app.listen).
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(runner).toHaveBeenCalledTimes(1);
    const snap = status.getBootstrapStatus();
    expect(snap.target_label).toBe("persisted-profile");
    expect(snap.phase).toBe("ready");
  });
});
