import { describe, it, expect, afterEach } from "vitest";
import { apiBase, getObservabilityKeys, getObservabilityMemory, getObservabilityShards } from "../../src/lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("api client", () => {
  it("apiBase defaults to http://localhost:3001", () => {
    expect(apiBase()).toBe("http://localhost:3001");
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

  it("getObservabilityShards calls /observability/shards", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ shards: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await getObservabilityShards();
    expect(result.shards).toEqual([]);
    expect(calls[0]).toMatch(/\/observability\/shards$/);
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await expect(getObservabilityKeys()).rejects.toThrow();
  });
});
