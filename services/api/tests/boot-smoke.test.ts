// Wave 5.15b boot-smoke regression gate.
//
// Loads services/api/src/index.ts as an ES module to verify every top-level
// identifier referenced inside main() resolves at runtime. The primary static
// gate is `tsc --noEmit` (wired into `npm test` ahead of vitest); this
// runtime test is a belt-and-suspenders check that catches the same class of
// bug (used-but-not-imported symbol) when it actually executes.
//
// Heavy deps are mocked so main() runs through to the bootstrap branch
// without touching Redis, the filesystem, or a real port.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/store.ts", () => ({
  createStore: vi.fn(async () => ({
    getActiveRaw: () => undefined,
    // Wave 5.16y — index.ts auto-activates the first stored profile when
    // none is active. The boot-smoke flow has no profiles, so `list()`
    // returns empty and `setActive` is never invoked, but both must exist
    // as functions so the static reference check passes.
    list: async () => [],
    setActive: async () => null,
  })),
}));

vi.mock("../src/seed.ts", () => ({
  seedConnections: vi.fn(async () => undefined),
}));

vi.mock("../src/bootstrap.ts", () => ({
  bootstrapFrtb: vi.fn(async () => undefined),
}));

vi.mock("../src/redis-ready.ts", () => ({
  ensureRedisReady: vi.fn(async () => ({
    connected: false,
    err: new Error("boot-smoke: redis unreachable (mocked)"),
  })),
}));

vi.mock("@frtb/redis-client", () => ({
  createRedisClient: vi.fn(() => ({
    quit: vi.fn(async () => undefined),
  })),
}));

vi.mock("@frtb/schema", () => ({
  loadSchema: vi.fn(() => undefined),
}));

describe("boot-smoke: services/api/src/index.ts loads without ReferenceError", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.FRTB_MASTER_KEY = "boot-smoke-test-key";
    process.env.SMOKE = "1";
    delete process.env.REDIS_URL;
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

  it("module evaluation does not surface a fatal ReferenceError", async () => {
    // ESM module evaluation runs `main().catch(...)` at the bottom of
    // index.ts. With Redis mocked unreachable, the bootstrap branch executes
    // markBootstrapSkipped("redis-unreachable") — if the import of
    // markBootstrap* were missing from index.ts's import block, that line
    // would throw ReferenceError, be caught by main()'s .catch handler, and
    // logged via console.error with `"status":"fatal"`.
    await import("../src/index.ts");

    // Flush microtasks so main() (and its .catch) settle before we assert.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    const fatalCalls = errorSpy.mock.calls.filter((call) => {
      const arg = call[0];
      return typeof arg === "string" && arg.includes('"status":"fatal"');
    });
    expect(fatalCalls).toEqual([]);
  });
});
