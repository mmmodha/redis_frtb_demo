// Wave 5.16u — active-target watcher tests.
//
// The production watcher polls the api's /internal/redis/active-target/full
// every 5s and rebuilds the ioredis client on `version` change. Tests inject
// a fake fetch + a fake redisFactory and drive polling manually via
// `pollOnce()` so the suite stays deterministic.

import { describe, it, expect, vi } from "vitest";
import { createActiveTargetWatcher, type ActiveTargetFull } from "../src/active-target-watcher.ts";
import type { Redis } from "ioredis";

interface FakeRedis {
  id: number;
  pingCalls: number;
  disconnectCalls: number;
  ping(): Promise<string>;
  disconnect(): void;
  call(): Promise<unknown>;
}

let nextId = 1;
function makeFakeRedis(): FakeRedis {
  const fr: FakeRedis = {
    id: nextId++,
    pingCalls: 0,
    disconnectCalls: 0,
    async ping() { this.pingCalls += 1; return "PONG"; },
    disconnect() { this.disconnectCalls += 1; },
    async call() { return null; },
  };
  return fr;
}

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const silentLogger = { info: () => undefined, warn: () => undefined };

describe("createActiveTargetWatcher", () => {
  it("fetches the api on startup and builds an ioredis client", async () => {
    const built: FakeRedis[] = [];
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
      redisFactory: (t) => {
        // Sanity: factory receives the full target including the password.
        expect(t.password).toBe("PW1");
        expect(t.host).toBe("rs.example.com");
        const r = makeFakeRedis();
        built.push(r);
        return r as unknown as Redis;
      },
      logger: silentLogger,
    });

    await watcher.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(String(calledUrl)).toContain("/internal/redis/active-target/full");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(built).toHaveLength(1);
    expect(built[0]!.pingCalls).toBe(1);
    expect(watcher.getRedis()).toBe(built[0] as unknown as Redis);
    await watcher.stop();
  });

  it("rebuilds the client and disconnects the old one when the version bumps", async () => {
    const built: FakeRedis[] = [];
    const responses: ActiveTargetFull[] = [
      { host: "h1", port: 6379, tls: false, db: 0, password: "P1", label: "first",  version: 1 },
      { host: "h2", port: 6380, tls: false, db: 0, password: "P2", label: "second", version: 2 },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => mkResponse(responses[Math.min(i++, responses.length - 1)]!));
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redisFactory: () => {
        const r = makeFakeRedis();
        built.push(r);
        return r as unknown as Redis;
      },
      logger: silentLogger,
    });

    await watcher.start();
    expect(built).toHaveLength(1);
    const firstClient = built[0]!;
    expect(firstClient.disconnectCalls).toBe(0);

    await watcher.pollOnce();
    expect(built).toHaveLength(2);
    const secondClient = built[1]!;
    expect(firstClient.disconnectCalls).toBe(1);
    expect(secondClient.disconnectCalls).toBe(0);
    expect(watcher.getRedis()).toBe(secondClient as unknown as Redis);

    // No version change → no further rebuild.
    await watcher.pollOnce();
    expect(built).toHaveLength(2);
    await watcher.stop();
  });

  it("preserves the current client and logs a warning when a poll fails", async () => {
    const built: FakeRedis[] = [];
    const warnings: Array<{ msg: string; err?: unknown }> = [];
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
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redisFactory: () => {
        const r = makeFakeRedis();
        built.push(r);
        return r as unknown as Redis;
      },
      logger: { info: () => undefined, warn: (msg, err) => warnings.push({ msg, err }) },
    });

    await watcher.start();
    const initial = built[0]!;
    expect(watcher.getRedis()).toBe(initial as unknown as Redis);

    await watcher.pollOnce();
    expect(built).toHaveLength(1);
    expect(initial.disconnectCalls).toBe(0);
    expect(watcher.getRedis()).toBe(initial as unknown as Redis);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toMatch(/poll failed/i);
    await watcher.stop();
  });

  it("getRedis() throws a clear error before start() resolves", () => {
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      redisFactory: () => makeFakeRedis() as unknown as Redis,
      logger: silentLogger,
    });
    expect(() => watcher.getRedis()).toThrow(/not initialised|before start/i);
  });

  // Wave 5.99 — regression: a wedged Redis client used to hang /sources
  // forever. asRedisLike().call(...) must reject within a bounded window,
  // force a re-poll, and transparently retry once against the swapped-in
  // client. Two scenarios: (a) retry succeeds against a recovered client,
  // (b) retry also fails — the second error propagates without hanging.
  describe("Wave 5.99 — wedged-client recovery", () => {
    function timeoutErr(): Error {
      const err = new Error("Command timed out");
      (err as Error & { name: string }).name = "MaxRetriesPerRequestError";
      return err;
    }

    it("retries asRedisLike().call() once against a swapped-in client after a transient error", async () => {
      const responses: ActiveTargetFull[] = [
        { host: "h1", port: 6379, tls: false, db: 0, password: "P1", label: "first",  version: 1 },
        { host: "h2", port: 6379, tls: false, db: 0, password: "P2", label: "second", version: 2 },
      ];
      let i = 0;
      const fetchImpl = vi.fn(async () => mkResponse(responses[Math.min(i++, responses.length - 1)]!));
      const built: Array<{ ping: () => Promise<string>; disconnect: () => void; call: ReturnType<typeof vi.fn> }> = [];
      const watcher = createActiveTargetWatcher({
        apiBase: "http://api:8080",
        token: "tok",
        pollMs: 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        redisFactory: () => {
          const wedged = built.length === 0;
          const r = {
            async ping() { return "PONG"; },
            disconnect: vi.fn(),
            call: wedged
              ? vi.fn(async () => { throw timeoutErr(); })
              : vi.fn(async () => ["a", "b"]),
          };
          built.push(r);
          return r as unknown as Redis;
        },
        logger: silentLogger,
      });

      await watcher.start();
      expect(built).toHaveLength(1);

      const result = await watcher.asRedisLike().call("SMEMBERS", "source:index");
      expect(result).toEqual(["a", "b"]);
      expect(built).toHaveLength(2);
      expect(built[0]!.call).toHaveBeenCalledTimes(1);
      expect(built[1]!.call).toHaveBeenCalledTimes(1);
      expect(built[0]!.disconnect).toHaveBeenCalled();

      await watcher.stop();
    });

    it("rejects within a bounded window when the retry also fails", async () => {
      const responses: ActiveTargetFull[] = [
        { host: "h1", port: 6379, tls: false, db: 0, password: "P1", label: "first",  version: 1 },
        { host: "h2", port: 6379, tls: false, db: 0, password: "P2", label: "second", version: 2 },
      ];
      let i = 0;
      const fetchImpl = vi.fn(async () => mkResponse(responses[Math.min(i++, responses.length - 1)]!));
      let totalCalls = 0;
      const watcher = createActiveTargetWatcher({
        apiBase: "http://api:8080",
        token: "tok",
        pollMs: 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        redisFactory: () => ({
          async ping() { return "PONG"; },
          disconnect: () => undefined,
          call: vi.fn(async () => { totalCalls += 1; throw timeoutErr(); }),
        } as unknown as Redis),
        logger: silentLogger,
      });

      await watcher.start();

      const t0 = Date.now();
      await expect(watcher.asRedisLike().call("SMEMBERS", "source:index")).rejects.toThrow(/timed out|max retries/i);
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(totalCalls).toBe(2); // initial attempt + exactly one retry

      await watcher.stop();
    });

    // The hardest case in production: ioredis's own commandTimeout option
    // doesn't always fire (TCP socket stays ESTABLISHED, no error event), so
    // the wrapper enforces its own Promise.race timeout. Without that race,
    // /sources would hang indefinitely waiting for SMEMBERS to resolve.
    it("times out (via wrapper Promise.race) when the underlying call never resolves", async () => {
      vi.useFakeTimers();
      try {
        const responses: ActiveTargetFull[] = [
          { host: "h1", port: 6379, tls: false, db: 0, password: "P1", label: "first",  version: 1 },
          { host: "h2", port: 6379, tls: false, db: 0, password: "P2", label: "second", version: 2 },
        ];
        let i = 0;
        const fetchImpl = vi.fn(async () => mkResponse(responses[Math.min(i++, responses.length - 1)]!));
        const watcher = createActiveTargetWatcher({
          apiBase: "http://api:8080",
          token: "tok",
          pollMs: 60_000,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          redisFactory: () => ({
            async ping() { return "PONG"; },
            disconnect: () => undefined,
            // The wedge we saw in production: command queued, never responds.
            call: vi.fn(() => new Promise<unknown>(() => { /* never resolves */ })),
          } as unknown as Redis),
          logger: silentLogger,
        });

        await watcher.start();
        const pending = watcher.asRedisLike().call("SMEMBERS", "source:index");
        // Attach the rejection handler BEFORE advancing fake time so the
        // intermediate rejection (initial-attempt timeout) is not flagged as
        // an unhandled rejection by vitest. Initial attempt times out (≤5s),
        // then re-poll, then retry times out (≤5s); advancing 11s surfaces
        // the final rejection.
        const assertion = expect(pending).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(11_000);
        await assertion;
        await watcher.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not retry when the error is non-transient", async () => {
      const target: ActiveTargetFull = { host: "h1", port: 6379, tls: false, db: 0, password: "P1", label: "x", version: 1 };
      const fetchImpl = vi.fn(async () => mkResponse(target));
      let calls = 0;
      const watcher = createActiveTargetWatcher({
        apiBase: "http://api:8080",
        token: "tok",
        pollMs: 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        redisFactory: () => ({
          async ping() { return "PONG"; },
          disconnect: () => undefined,
          call: vi.fn(async () => { calls += 1; throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value"); }),
        } as unknown as Redis),
        logger: silentLogger,
      });

      await watcher.start();
      await expect(watcher.asRedisLike().call("SMEMBERS", "source:index")).rejects.toThrow(/WRONGTYPE/);
      expect(calls).toBe(1);
      await watcher.stop();
    });
  });
});
