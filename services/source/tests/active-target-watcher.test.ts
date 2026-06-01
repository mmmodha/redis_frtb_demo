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
});
