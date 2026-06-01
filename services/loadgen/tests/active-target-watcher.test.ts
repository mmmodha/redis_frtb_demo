// Wave 5.16v — loadgen active-target watcher tests.
//
// Mirrors source/tests/active-target-watcher.test.ts. loadgen does not hold
// an ioredis client, so the watcher's contract is narrower: poll the api,
// track `version`, log every swap with the run-in-flight flag, never crash
// on transient api failures.

import { describe, it, expect, vi } from "vitest";
import { createActiveTargetWatcher, type ActiveTargetFull } from "../src/active-target-watcher.ts";

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const silentLogger = { info: () => undefined, warn: () => undefined };

describe("createActiveTargetWatcher (loadgen)", () => {
  it("fetches the api on startup with the bearer token and records the initial target", async () => {
    const target: ActiveTargetFull = {
      host: "rs.example.com", port: 12000, tls: true, db: 0,
      password: "PW1", label: "rs-demo", version: 5,
    };
    const fetchImpl = vi.fn(async () => mkResponse(target));
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger,
    });

    await watcher.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(String(calledUrl)).toContain("/internal/redis/active-target/full");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });

    const cur = watcher.getCurrent();
    expect(cur.label).toBe("rs-demo");
    expect(cur.version).toBe(5);
    // Defence-in-depth: getCurrent() never returns the password to callers.
    expect((cur as ActiveTargetFull & { password?: string }).password).toBeUndefined();
    await watcher.stop();
  });

  it("logs an info line on every version bump and skips logging when version is unchanged", async () => {
    const responses: ActiveTargetFull[] = [
      { host: "h1", port: 6379, tls: false, db: 0, password: "P1", label: "first",  version: 1 },
      { host: "h2", port: 6380, tls: false, db: 0, password: "P2", label: "second", version: 2 },
      { host: "h2", port: 6380, tls: false, db: 0, password: "P2", label: "second", version: 2 },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => mkResponse(responses[Math.min(i++, responses.length - 1)]!));
    const infos: string[] = [];
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { info: (m) => infos.push(m), warn: () => undefined },
      isRunning: () => false,
    });

    await watcher.start();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatch(/first/);
    expect(infos[0]).toMatch(/running=false/);

    await watcher.pollOnce();
    expect(infos).toHaveLength(2);
    expect(infos[1]).toMatch(/second/);
    expect(watcher.getCurrent().version).toBe(2);

    // No version change → no further swap log.
    await watcher.pollOnce();
    expect(infos).toHaveLength(2);
    await watcher.stop();
  });

  it("records running=true in the swap log when isRunning() reports a run is active", async () => {
    // This guards the 5.16w lockout — if we ever see running=true here in
    // integration logs, the api let a swap through mid-run.
    const target: ActiveTargetFull = {
      host: "h", port: 6379, tls: false, db: 0, label: "L", version: 9,
    };
    const fetchImpl = vi.fn(async () => mkResponse(target));
    const infos: string[] = [];
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { info: (m) => infos.push(m), warn: () => undefined },
      isRunning: () => true,
    });

    await watcher.start();
    expect(infos[0]).toMatch(/running=true/);
    await watcher.stop();
  });

  it("preserves the current target and logs a warning when a poll fails", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return mkResponse({
          host: "h1", port: 6379, tls: false, db: 0, password: "P1", label: "first", version: 1,
        });
      }
      return new Response("boom", { status: 500 });
    });
    const warnings: Array<{ msg: string; err?: unknown }> = [];
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { info: () => undefined, warn: (msg, err) => warnings.push({ msg, err }) },
    });

    await watcher.start();
    expect(watcher.getCurrent().label).toBe("first");

    await watcher.pollOnce();
    expect(watcher.getCurrent().label).toBe("first");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toMatch(/poll failed/i);
    await watcher.stop();
  });

  it("getCurrent() throws a clear error before start() resolves", () => {
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(() => watcher.getCurrent()).toThrow(/before a successful poll/i);
  });
});
