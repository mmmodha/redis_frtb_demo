// Wave 5.55 — ingest active-target watcher tests.
//
// The watcher polls the api's /internal/redis/active-target/full endpoint
// and, on every `version` change, builds a new ioredis client, invokes the
// onTargetChange callback (so cli.ts can drain the XREADGROUP loop and
// resume on the new client), then disconnects the previous client. Tests
// inject fake fetch + fake redisFactory and drive polling manually via
// `pollOnce()` so the suite stays deterministic.

import { describe, it, expect, vi } from "vitest";
import {
  createActiveTargetWatcher,
  type ActiveTargetFull,
  type SwapContext,
} from "../src/active-target-watcher.ts";
import type { RedisLike } from "../src/consumer.ts";

interface FakeRedis {
  id: number;
  disconnectCalls: number;
  disconnect(): void;
}

let nextId = 1;
function makeFakeRedis(): FakeRedis {
  return {
    id: nextId++,
    disconnectCalls: 0,
    disconnect() { this.disconnectCalls += 1; },
  };
}

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const silentLogger = { info: () => undefined, warn: () => undefined };

describe("createActiveTargetWatcher (ingest)", () => {
  it("fetches the api on startup with the bearer token and builds a client", async () => {
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
        return r as unknown as RedisLike;
      },
      logger: silentLogger,
    });

    await watcher.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(String(calledUrl)).toContain("/internal/redis/active-target/full");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(built).toHaveLength(1);
    expect(watcher.getRedis()).toBe(built[0] as unknown as RedisLike);
    expect(watcher.getCurrent().label).toBe("rs-demo");
    await watcher.stop();
  });

  it("rebuilds the client, fires onTargetChange, then disconnects the old one when version bumps", async () => {
    const built: FakeRedis[] = [];
    const swaps: Array<{ next: SwapContext; prev: SwapContext | null }> = [];
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
        return r as unknown as RedisLike;
      },
      onTargetChange: async (next, prev) => {
        // Order check: at the moment the callback runs, the previous client
        // must NOT have been disconnected yet — that's the contract that
        // lets cli.ts drain its consumer before the socket goes away.
        if (prev) expect((prev.client as unknown as FakeRedis).disconnectCalls).toBe(0);
        swaps.push({ next, prev });
      },
      logger: silentLogger,
    });

    await watcher.start();
    expect(built).toHaveLength(1);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]!.prev).toBeNull();
    expect(swaps[0]!.next.target.label).toBe("first");
    const firstClient = built[0]!;
    expect(firstClient.disconnectCalls).toBe(0);

    await watcher.pollOnce();
    expect(built).toHaveLength(2);
    expect(swaps).toHaveLength(2);
    expect(swaps[1]!.prev?.target.label).toBe("first");
    expect(swaps[1]!.next.target.label).toBe("second");
    const secondClient = built[1]!;
    // After the callback resolved, the old client must have been disconnected.
    expect(firstClient.disconnectCalls).toBe(1);
    expect(secondClient.disconnectCalls).toBe(0);
    expect(watcher.getRedis()).toBe(secondClient as unknown as RedisLike);

    // No version change → no further rebuild and no further callback.
    await watcher.pollOnce();
    expect(built).toHaveLength(2);
    expect(swaps).toHaveLength(2);
    await watcher.stop();
  });

  it("emits the spec's structured target-switch log on every swap", async () => {
    const responses: ActiveTargetFull[] = [
      { host: "h1", port: 6379, tls: false, db: 0, label: "local",       version: 1 },
      { host: "h2", port: 6380, tls: false, db: 0, label: "testcluster", version: 2 },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => mkResponse(responses[Math.min(i++, responses.length - 1)]!));
    const infos: string[] = [];
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redisFactory: () => makeFakeRedis() as unknown as RedisLike,
      logger: { info: (m) => infos.push(m), warn: () => undefined },
    });

    await watcher.start();
    expect(infos).toHaveLength(1);
    const initial = JSON.parse(infos[0]!);
    expect(initial).toMatchObject({
      service: "ingest", action: "target-switch", from: null, to: "local",
    });

    await watcher.pollOnce();
    expect(infos).toHaveLength(2);
    const swap = JSON.parse(infos[1]!);
    expect(swap).toMatchObject({
      service: "ingest", action: "target-switch", from: "local", to: "testcluster",
    });
    await watcher.stop();
  });

  it("preserves the current client and logs a warning when a poll fails", async () => {
    const built: FakeRedis[] = [];
    const warnings: Array<{ msg: string }> = [];
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
        return r as unknown as RedisLike;
      },
      logger: { info: () => undefined, warn: (msg) => warnings.push({ msg }) },
    });

    await watcher.start();
    const initial = built[0]!;
    expect(watcher.getRedis()).toBe(initial as unknown as RedisLike);

    await watcher.pollOnce();
    expect(built).toHaveLength(1);
    expect(initial.disconnectCalls).toBe(0);
    expect(watcher.getRedis()).toBe(initial as unknown as RedisLike);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toMatch(/poll failed/i);
    await watcher.stop();
  });

  it("retries with exponential backoff on the initial fetch and eventually succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < 3) return new Response("not ready", { status: 503 });
      return mkResponse({
        host: "h1", port: 6379, tls: false, db: 0, label: "first", version: 1,
      });
    });
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      pollMs: 60_000,
      // Shrink the retry base so the test stays fast (still exercises the
      // backoff sequence — 1ms, 2ms, 4ms, ...).
      initialRetryMs: 1,
      initialTimeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redisFactory: () => makeFakeRedis() as unknown as RedisLike,
      logger: silentLogger,
    });

    await watcher.start();
    expect(call).toBe(3);
    expect(watcher.getCurrent().label).toBe("first");
    await watcher.stop();
  });

  it("getRedis() throws a clear error before start() resolves", () => {
    const watcher = createActiveTargetWatcher({
      apiBase: "http://api:8080",
      token: "tok",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      redisFactory: () => makeFakeRedis() as unknown as RedisLike,
      logger: silentLogger,
    });
    expect(() => watcher.getRedis()).toThrow(/before start/i);
  });
});
