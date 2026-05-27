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

  it("defaults to Cluster mode (per Wave 5 target topology)", () => {
    process.env.REDIS_URL = "redis://:pw@seed.example.com:10395";
    createRedisClient();
    expect(clusterCtor).toHaveBeenCalledTimes(1);
    expect(redisCtor).not.toHaveBeenCalled();
    const [nodes, opts] = clusterCtor.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(nodes).toEqual([{ host: "seed.example.com", port: 10395 }]);
    const redisOptions = (opts as { redisOptions?: Record<string, unknown> }).redisOptions ?? {};
    expect(redisOptions.password).toBe("pw");
  });

  it("uses standalone Redis when REDIS_CLUSTER=false", () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    process.env.REDIS_CLUSTER = "false";
    createRedisClient();
    expect(redisCtor).toHaveBeenCalledTimes(1);
    expect(clusterCtor).not.toHaveBeenCalled();
  });

  it("passes tls option when REDIS_TLS=true even on redis:// scheme", () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    process.env.REDIS_TLS = "true";
    createRedisClient();
    const [, opts] = clusterCtor.mock.calls[0] as [unknown, Record<string, unknown>];
    const redisOptions = (opts as { redisOptions?: Record<string, unknown> }).redisOptions ?? {};
    expect(redisOptions.tls).toBeDefined();
  });

  it("accepts an explicit url argument overriding env", () => {
    process.env.REDIS_URL = "redis://:env@envhost:6379";
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
    createRedisClient({ lazyConnect: true, maxRetriesPerRequest: 3 });
    const [, opts] = clusterCtor.mock.calls[0] as [unknown, Record<string, unknown>];
    const redisOptions = (opts as { redisOptions?: Record<string, unknown> }).redisOptions ?? {};
    expect(redisOptions.lazyConnect).toBe(true);
    expect(redisOptions.maxRetriesPerRequest).toBe(3);
  });
});
