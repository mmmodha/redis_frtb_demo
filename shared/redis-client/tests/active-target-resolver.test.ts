// Wave 6.39.F — unit tests for the one-shot Redis target resolver. Covers
// the 4-tier precedence used by the generator CLI:
//   1. Explicit URL wins (operator escape hatch).
//   2. Live active-target wins when apiBase + token configured + api reachable.
//   3. envRedisUrl is the bootstrap fallback when the api is unreachable.
//   4. No source available → hard error with a clear message.

import { describe, it, expect, vi } from "vitest";
import { resolveRedisTarget, buildRedisUrlFromTarget, type ActiveTargetFull } from "../src/active-target-resolver.ts";

function makeLogger() {
  return {
    info: vi.fn<(obj: object, msg: string) => void>(),
    warn: vi.fn<(obj: object, msg: string) => void>(),
  };
}

function makeFetch(body: ActiveTargetFull | { error: string }, status = 200): typeof fetch {
  return (async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeUnreachableFetch(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8080");
  }) as unknown as typeof fetch;
}

describe("buildRedisUrlFromTarget", () => {
  it("builds redis:// URL for non-tls target", () => {
    const url = buildRedisUrlFromTarget({
      host: "localhost", port: 12000, tls: false, db: 0, label: "local", version: 3,
    });
    expect(url).toBe("redis://localhost:12000/0");
  });

  it("builds rediss:// URL for tls target and embeds password", () => {
    const url = buildRedisUrlFromTarget({
      host: "h.example.com", port: 14596, tls: true, db: 0, password: "p@ss/word", label: "cloud", version: 1,
    });
    expect(url).toBe("rediss://:p%40ss%2Fword@h.example.com:14596/0");
  });
});

describe("resolveRedisTarget — 4-tier precedence", () => {
  it("Test 1: explicit --redis-url wins over active-target and env", async () => {
    const logger = makeLogger();
    const fetchImpl = makeFetch({
      host: "active.example.com", port: 6379, tls: false, db: 0, label: "active", version: 1,
    });
    const r = await resolveRedisTarget({
      explicitUrl: "redis://explicit:1111",
      apiBase: "http://api:8080",
      token: "tok",
      envRedisUrl: "redis://env:2222",
      fetchImpl,
      logger,
    });
    expect(r.source).toBe("explicit");
    expect(r.url).toBe("redis://explicit:1111");
    expect(r.host).toBe("explicit");
    expect(r.port).toBe(1111);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: "explicit", host: "explicit", port: 1111 }),
      "redis target resolved",
    );
  });

  it("Test 2: active-target endpoint returns {host:'h',port:1234,...} → constructed URL used", async () => {
    const logger = makeLogger();
    const fetchImpl = makeFetch({
      host: "h", port: 1234, tls: false, db: 0, label: "localcluster", version: 7,
    });
    const r = await resolveRedisTarget({
      apiBase: "http://api:8080",
      token: "tok",
      envRedisUrl: "redis://env:2222",
      fetchImpl,
      logger,
    });
    expect(r.source).toBe("active-target");
    expect(r.url).toBe("redis://h:1234/0");
    expect(r.host).toBe("h");
    expect(r.port).toBe(1234);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: "active-target", host: "h", port: 1234 }),
      "redis target resolved",
    );
  });

  it("Test 3: API unreachable + REDIS_URL set → fallback works, warning emitted", async () => {
    const logger = makeLogger();
    const r = await resolveRedisTarget({
      apiBase: "http://api:8080",
      token: "tok",
      envRedisUrl: "redis://env-host:2222",
      fetchImpl: makeUnreachableFetch(),
      logger,
    });
    expect(r.source).toBe("env");
    expect(r.url).toBe("redis://env-host:2222");
    expect(r.host).toBe("env-host");
    expect(r.port).toBe(2222);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ apiBase: "http://api:8080" }),
      expect.stringMatching(/active-target fetch failed/),
    );
  });

  it("Test 4: API unreachable + no REDIS_URL → fatal error with clear message", async () => {
    const logger = makeLogger();
    await expect(
      resolveRedisTarget({
        apiBase: "http://api:8080",
        token: "tok",
        fetchImpl: makeUnreachableFetch(),
        logger,
      }),
    ).rejects.toThrow(/redis target missing.*--redis-url.*API_URL.*INTERNAL_API_TOKEN.*REDIS_URL/s);
  });

  it("API returns non-200 → falls back to env with warning", async () => {
    const logger = makeLogger();
    const fetchImpl = makeFetch({ error: "unauthorized" }, 401);
    const r = await resolveRedisTarget({
      apiBase: "http://api:8080",
      token: "tok",
      envRedisUrl: "redis://env:2222",
      fetchImpl,
      logger,
    });
    expect(r.source).toBe("env");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("no apiBase/token configured → tier 2 silently skipped, env used", async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn();
    const r = await resolveRedisTarget({
      envRedisUrl: "redis://env:2222",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    expect(r.source).toBe("env");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("constructs rediss:// URL when active-target has tls=true", async () => {
    const logger = makeLogger();
    const fetchImpl = makeFetch({
      host: "secure.example.com", port: 14596, tls: true, db: 0, password: "secret", label: "cloud", version: 2,
    });
    const r = await resolveRedisTarget({
      apiBase: "http://api:8080",
      token: "tok",
      fetchImpl,
      logger,
    });
    expect(r.source).toBe("active-target");
    expect(r.url).toMatch(/^rediss:\/\/:secret@secure\.example\.com:14596\/0$/);
  });
});
