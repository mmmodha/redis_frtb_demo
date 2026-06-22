import { describe, it, expect, afterEach } from "vitest";
import { apiBase, getObservabilityKeys, getObservabilityMemory, getObservabilityPerShard, getObservabilityShards } from "../../src/lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("api client", () => {
  it('apiBase defaults to "/api" (same-origin proxy)', () => {
    expect(apiBase()).toBe("/api");
  });

  it("getObservabilityKeys calls /observability/keys?prefix=sens: by default", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ prefix: "sens:", dbsize: 5, sample: [], sample_size: 0, ms: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await getObservabilityKeys();
    expect(result.dbsize).toBe(5);
    expect(calls[0]).toMatch(/\/observability\/keys\?prefix=sens:$/);
  });

  it("getObservabilityMemory calls /observability/memory", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ used_memory: 42, used_memory_human: "42B", ms: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await getObservabilityMemory();
    expect(result.used_memory).toBe(42);
    expect(calls[0]).toMatch(/\/observability\/memory$/);
  });

  it("getObservabilityShards calls /observability/shards and returns an array", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify([]), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await getObservabilityShards();
    expect(result).toEqual([]);
    expect(calls[0]).toMatch(/\/observability\/shards$/);
  });

  it("getObservabilityPerShard calls /observability/per-shard and returns the row array", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify([
        { shard_id: "redis:1", role: "master", memory_used: 1024, key_count: 10, write_ops_per_sec: 5, index_lag: 0, last_observed_at: null, snapshot_age_seconds: null },
      ]), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await getObservabilityPerShard();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.shard_id).toBe("redis:1");
    expect(calls[0]).toMatch(/\/observability\/per-shard$/);
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await expect(getObservabilityKeys()).rejects.toThrow();
  });
});
