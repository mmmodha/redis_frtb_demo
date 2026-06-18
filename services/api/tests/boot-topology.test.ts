// Wave 6.35.A — boot topology regression gate.
//
// When the api boot path constructs the initial Redis client from REDIS_URL,
// it MUST honour the active profile's `clusterMode` field (set by seed.ts /
// activeRaw) instead of falling back to `createRedisClient`'s default
// cluster=true. Otherwise a standalone Redis target gets an ioredis Cluster
// client, which then emits `ClusterAllFailedError: Failed to refresh slots
// cache` stack traces on stdout before scheduleBootstrap re-resolves topology
// via the standalone-aware path.
//
// This test pins the boot-client topology decision by spying on
// `createRedisClient` and asserting the `cluster` option matches the persisted
// activeRaw.clusterMode. Companion to boot-ordering.test.ts (which pins the
// scheduleBootstrap firing order) and boot-smoke.test.ts (which pins the
// import graph).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createRedisClientSpy = vi.fn(() => ({
  quit: vi.fn(async () => undefined),
}));

vi.mock("@frtb/redis-client", () => ({
  createRedisClient: createRedisClientSpy,
}));

vi.mock("../src/seed.ts", () => ({
  seedConnections: vi.fn(async () => undefined),
}));

vi.mock("../src/bootstrap.ts", () => ({
  bootstrapFrtb: vi.fn(async () => undefined),
  BootstrapPartialError: class BootstrapPartialError extends Error {
    failures: unknown[] = [];
  },
}));

vi.mock("../src/redis-ready.ts", () => ({
  ensureRedisReady: vi.fn(async () => ({
    connected: false,
    mode: "standalone",
    err: new Error("boot-topology: redis unreachable (mocked)"),
  })),
}));

vi.mock("@frtb/schema", () => ({
  loadSchema: vi.fn(() => undefined),
}));

function mockStoreWithActive(activeRaw: {
  host: string;
  port: number;
  tls: { enabled: boolean };
  db: number;
  name: string;
  clusterMode: boolean;
}): void {
  vi.doMock("../src/store.ts", () => ({
    createStore: vi.fn(async () => ({
      getActiveRaw: () => activeRaw,
      list: async () => [],
      setActive: async () => null,
    })),
  }));
}

describe("Wave 6.35.A — boot client topology matches activeRaw.clusterMode", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.FRTB_MASTER_KEY = "boot-topology-test-key";
    process.env.SMOKE = "1";
    process.env.API_PORT = "0";
    process.env.REDIS_URL = "redis://127.0.0.1:6390";
    createRedisClientSpy.mockClear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.env = originalEnv;
    vi.resetModules();
    vi.doUnmock("../src/store.ts");
  });

  it("standalone profile (clusterMode=false) builds a non-cluster boot client", async () => {
    mockStoreWithActive({
      host: "127.0.0.1",
      port: 6390,
      tls: { enabled: false },
      db: 0,
      name: "live-standalone",
      clusterMode: false,
    });

    await import("../src/index.ts");

    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    expect(createRedisClientSpy).toHaveBeenCalledTimes(1);
    const opts = createRedisClientSpy.mock.calls[0]?.[0] as { cluster?: boolean } | undefined;
    expect(opts?.cluster).toBe(false);
  });

  it("cluster profile (clusterMode=true) builds a cluster boot client", async () => {
    mockStoreWithActive({
      host: "127.0.0.1",
      port: 6390,
      tls: { enabled: false },
      db: 0,
      name: "live-cluster",
      clusterMode: true,
    });

    await import("../src/index.ts");

    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    expect(createRedisClientSpy).toHaveBeenCalledTimes(1);
    const opts = createRedisClientSpy.mock.calls[0]?.[0] as { cluster?: boolean } | undefined;
    expect(opts?.cluster).toBe(true);
  });

  it("standalone profile boot emits zero ClusterAllFailedError lines on stdout/stderr", async () => {
    mockStoreWithActive({
      host: "127.0.0.1",
      port: 6390,
      tls: { enabled: false },
      db: 0,
      name: "live-standalone",
      clusterMode: false,
    });

    await import("../src/index.ts");

    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    const collect = (spy: ReturnType<typeof vi.spyOn>): string =>
      spy.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : "")).join("\n");
    const combined =
      collect(errorSpy) + "\n" + collect(logSpy) + "\n" +
      collect(stdoutWriteSpy) + "\n" + collect(stderrWriteSpy);
    expect(combined).not.toMatch(/ClusterAllFailedError/);
    expect(combined).not.toMatch(/Failed to refresh slots cache/);
  });
});
