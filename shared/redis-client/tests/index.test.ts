// TDD — tests written before implementation. Verifies the factory parses
// REDIS_URL + REDIS_CLUSTER + REDIS_TLS into either an ioredis Cluster or
// Redis instance with the expected node list / options, including password.
//
// We mock ioredis so the tests never open a socket — just assert the
// constructor was called with the right shape.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const redisCtor = vi.fn();
const clusterCtor = vi.fn();

vi.mock("ioredis", () => {
  class Redis { constructor(...args: unknown[]) { redisCtor(...args); } }
  class Cluster { constructor(...args: unknown[]) { clusterCtor(...args); } }
  return { default: Redis, Redis, Cluster };
});

import { createRedisClient, parseRedisUrl } from "../src/index.ts";

describe("parseRedisUrl", () => {
  it("parses host/port/password/tls from rediss://:pw@host:port", () => {
    const p = parseRedisUrl("rediss://:secretpw@redis.example.com:10395/0");
    expect(p.host).toBe("redis.example.com");
    expect(p.port).toBe(10395);
    expect(p.password).toBe("secretpw");
    expect(p.tls).toBe(true);
    expect(p.db).toBe(0);
  });

  it("parses redis:// (plain) without tls", () => {
    const p = parseRedisUrl("redis://:pw@host:6379");
    expect(p.tls).toBe(false);
    expect(p.password).toBe("pw");
  });

  it("handles URL-encoded passwords", () => {
    const p = parseRedisUrl("redis://:p%40ss%2Fword@host:6379");
    expect(p.password).toBe("p@ss/word");
  });

  it("defaults port to 6379 when omitted", () => {
    const p = parseRedisUrl("redis://host");
    expect(p.port).toBe(6379);
  });
});

describe("createRedisClient", () => {
  beforeEach(() => {
    redisCtor.mockReset();
    clusterCtor.mockReset();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_CLUSTER;
    delete process.env.REDIS_TLS;
  });
  afterEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_CLUSTER;
    delete process.env.REDIS_TLS;
  });

  // Wave 6.39.E — Enterprise-first default. The Enterprise proxy endpoint
  // blocks `CLUSTER SLOTS`, so the factory defaults to standalone and OSS
  // operators must opt in explicitly via REDIS_CLUSTER=true.
  it("defaults to standalone Redis when REDIS_CLUSTER is unset (Enterprise-first)", () => {
    process.env.REDIS_URL = "redis://:pw@seed.example.com:10395";
    createRedisClient();
    expect(redisCtor).toHaveBeenCalledTimes(1);
    expect(clusterCtor).not.toHaveBeenCalled();
    const [opts] = redisCtor.mock.calls[0] as [Record<string, unknown>];
    expect(opts.host).toBe("seed.example.com");
    expect(opts.port).toBe(10395);
    expect(opts.password).toBe("pw");
  });

  it("uses standalone Redis when REDIS_CLUSTER=false (explicit opt-out)", () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    process.env.REDIS_CLUSTER = "false";
    createRedisClient();
    expect(redisCtor).toHaveBeenCalledTimes(1);
    expect(clusterCtor).not.toHaveBeenCalled();
  });

  // Wave 6.39.E regression guard — explicit opt-in must still select cluster
  // mode for OSS-cluster operators that were relying on the old default.
  it("uses Cluster mode when REDIS_CLUSTER=true (explicit opt-in)", () => {
    process.env.REDIS_URL = "redis://:pw@seed.example.com:10395";
    process.env.REDIS_CLUSTER = "true";
    createRedisClient();
    expect(clusterCtor).toHaveBeenCalledTimes(1);
    expect(redisCtor).not.toHaveBeenCalled();
    const [nodes, opts] = clusterCtor.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(nodes).toEqual([{ host: "seed.example.com", port: 10395 }]);
    const redisOptions = (opts as { redisOptions?: Record<string, unknown> }).redisOptions ?? {};
    expect(redisOptions.password).toBe("pw");
  });

  it("passes tls option when REDIS_TLS=true even on redis:// scheme", () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    process.env.REDIS_TLS = "true";
    process.env.REDIS_CLUSTER = "true";
    createRedisClient();
    const [, opts] = clusterCtor.mock.calls[0] as [unknown, Record<string, unknown>];
    const redisOptions = (opts as { redisOptions?: Record<string, unknown> }).redisOptions ?? {};
    expect(redisOptions.tls).toBeDefined();
  });

  it("accepts an explicit url argument overriding env", () => {
    process.env.REDIS_URL = "redis://:env@envhost:6379";
    process.env.REDIS_CLUSTER = "true";
    createRedisClient({ url: "redis://:arg@arghost:7000" });
    const [nodes] = clusterCtor.mock.calls[0] as [Array<{ host: string; port: number }>];
    expect(nodes[0]?.host).toBe("arghost");
    expect(nodes[0]?.port).toBe(7000);
  });

  it("throws when no URL is provided (and no env fallback)", () => {
    expect(() => createRedisClient()).toThrow(/REDIS_URL/);
  });

  it("passes through lazyConnect + maxRetriesPerRequest defaults to redisOptions", () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    process.env.REDIS_CLUSTER = "true";
    createRedisClient({ lazyConnect: true, maxRetriesPerRequest: 3 });
    const [, opts] = clusterCtor.mock.calls[0] as [unknown, Record<string, unknown>];
    const redisOptions = (opts as { redisOptions?: Record<string, unknown> }).redisOptions ?? {};
    expect(redisOptions.lazyConnect).toBe(true);
    expect(redisOptions.maxRetriesPerRequest).toBe(3);
  });

  // Wave 6.18a — sockets surviving long idle windows on Redis Enterprise
  // proxies zombie into MaxRetriesPerRequestError unless keepAlive is set.
  // The factory must emit keepAlive=30000 for BOTH the Cluster path (via
  // clusterOptions.redisOptions) and the standalone Redis constructor.
  it("emits keepAlive=30000 in redisOptions for cluster mode", () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    process.env.REDIS_CLUSTER = "true";
    createRedisClient();
    const [, opts] = clusterCtor.mock.calls[0] as [unknown, Record<string, unknown>];
    const redisOptions = (opts as { redisOptions?: Record<string, unknown> }).redisOptions ?? {};
    expect(redisOptions.keepAlive).toBe(30000);
  });

  it("emits keepAlive=30000 in standalone Redis options", () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    process.env.REDIS_CLUSTER = "false";
    createRedisClient();
    const [opts] = redisCtor.mock.calls[0] as [Record<string, unknown>];
    expect(opts.keepAlive).toBe(30000);
  });
});
