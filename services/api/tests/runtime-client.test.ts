// Wave 6.18f — verifies the per-route Redis client uses the runtime
// commandTimeout (35s) wired separately from the Wave 6.18c boot-protection
// client (10s).
//
// Why this test exists: VM evidence (calc-discovery-failed × 24, all at
// exactly 10s) showed routes being aborted by the boot-protection ioredis
// commandTimeout before the in-Redis FT_AGGREGATE TIMEOUT directive
// (`FT_AGGREGATE_TIMEOUT_MS = 30_000` in src/sbm/aggregate-via-index.ts)
// could fire. Routes must instead resolve to a client whose commandTimeout
// comfortably exceeds 30s so Redis itself returns a clean recoverable error
// on slow aggregations. The boot client (10s) is preserved so a wedged
// socket still cannot block `app.listen(...)`.
//
// Wave 6.21 — the runtime client is now backed by a small ROUND-ROBIN POOL
// rather than a singleton. The boot client stays a singleton (the boot path
// is a single infrequent call). The assertions here are updated to:
//   * acknowledge that successive `getActiveRedisRuntimeClient()` calls
//     return DIFFERENT pool members (round-robin), and
//   * preserve the original invariants: every member's `commandTimeout` is
//     35s, the boot client's is 10s, both authenticate, and a credentials
//     rotation invalidates BOTH caches in lockstep.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getActiveRedisClient,
  getActiveRedisRuntimeClient,
  resetActiveTarget,
  setActiveTarget,
} from "../src/active-target.ts";

interface ClientWithOptions {
  options: { commandTimeout?: number; host: string; password?: string };
  disconnect: () => void;
}

describe("Wave 6.18f — runtime Redis client (35s) separate from boot client (10s)", () => {
  beforeEach(() => {
    resetActiveTarget();
    delete process.env.REDIS_URL;
    delete process.env.RUNTIME_REDIS_COMMAND_TIMEOUT_MS;
  });
  afterEach(() => {
    resetActiveTarget();
    delete process.env.RUNTIME_REDIS_COMMAND_TIMEOUT_MS;
  });

  it("routes resolve to a runtime client with commandTimeout=35_000 while the boot client keeps 10_000", () => {
    setActiveTarget(
      { host: "rs.example.com", port: 12000, tls: true, db: 0, label: "runtime-target" },
      { username: "appuser", password: "PW-PASS" },
    );

    const boot = getActiveRedisClient() as unknown as ClientWithOptions;
    const runtime = getActiveRedisRuntimeClient() as unknown as ClientWithOptions;

    // Both clients are built, both authenticated, but with different timeouts.
    expect(boot.options.commandTimeout).toBe(10_000);
    expect(runtime.options.commandTimeout).toBe(35_000);
    // Distinct instances so a request issued on the runtime path cannot
    // accidentally inherit the 10s boot cap.
    expect(runtime).not.toBe(boot);
    // Both must still authenticate against the active target (no regression
    // in the Wave 5.16y creds wiring).
    expect(runtime.options.host).toBe("rs.example.com");
    expect(runtime.options.password).toBe("PW-PASS");

    // Wave 6.21 — boot client stability: the boot client stays a singleton,
    // so re-fetching returns the same instance until a setActiveTarget
    // rotation bumps credsGeneration.
    expect(getActiveRedisClient()).toBe(boot as unknown as ReturnType<typeof getActiveRedisClient>);

    // Wave 6.21 — runtime client invariant: every pool member carries the
    // 35s commandTimeout and authenticates against the active target. The
    // pool rotates per acquisition so subsequent calls may return different
    // members, but every returned member must honour the timeout.
    for (let i = 0; i < 8; i++) {
      const m = getActiveRedisRuntimeClient() as unknown as ClientWithOptions;
      expect(m.options.commandTimeout).toBe(35_000);
      expect(m.options.host).toBe("rs.example.com");
      expect(m.options.password).toBe("PW-PASS");
    }

    // A credentials rotation invalidates BOTH caches in lockstep.
    setActiveTarget(
      { host: "rs.example.com", port: 12000, tls: true, db: 0, label: "runtime-target" },
      { username: "appuser", password: "PW-ROTATED" },
    );
    const bootAfter = getActiveRedisClient() as unknown as ClientWithOptions;
    const runtimeAfter = getActiveRedisRuntimeClient() as unknown as ClientWithOptions;
    expect(bootAfter).not.toBe(boot);
    // Post-rotation the pool members are also rebuilt (lazy on next
    // acquisition); whatever pool slot we land on holds a fresh client.
    expect(runtimeAfter).not.toBe(runtime);
    expect(runtimeAfter.options.commandTimeout).toBe(35_000);
    expect(bootAfter.options.commandTimeout).toBe(10_000);

    // RUNTIME_REDIS_COMMAND_TIMEOUT_MS env override applies on the next
    // build (smoke for ops dial-back without code changes).
    process.env.RUNTIME_REDIS_COMMAND_TIMEOUT_MS = "25000";
    setActiveTarget(
      { host: "rs.example.com", port: 12000, tls: true, db: 0, label: "runtime-target" },
      { username: "appuser", password: "PW-ROTATED" },
    );
    const runtimeEnv = getActiveRedisRuntimeClient() as unknown as ClientWithOptions;
    const bootEnv = getActiveRedisClient() as unknown as ClientWithOptions;
    expect(runtimeEnv.options.commandTimeout).toBe(25_000);
    // The boot client's commandTimeout is hard-coded (Wave 6.18c invariant)
    // and MUST NOT pick up the runtime env var.
    expect(bootEnv.options.commandTimeout).toBe(10_000);

    boot.disconnect();
    runtime.disconnect();
    bootAfter.disconnect();
    runtimeAfter.disconnect();
    bootEnv.disconnect();
    runtimeEnv.disconnect();
  });
});
