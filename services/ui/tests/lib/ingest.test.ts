import { describe, it, expect, afterEach } from "vitest";
import { listSources, startIngest, startGenerator } from "../../src/lib/ingest";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ingest api client", () => {
  it("listSources GETs /sources and returns parsed body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify([{ id: "src-1", kind: "synthetic" }]), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const sources = await listSources();
    expect(sources).toEqual([{ id: "src-1", kind: "synthetic" }]);
    expect(calls[0]!.url).toMatch(/\/sources$/);
  });

  it("startIngest POSTs /sources/:id/ingest", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true, run_id: "r1" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const res = await startIngest("src-1");
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toMatch(/\/sources\/src-1\/ingest$/);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("startGenerator POSTs /generator/start as a fallback", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await startGenerator();
    expect(calls[0]!.url).toMatch(/\/generator\/start$/);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("startIngest throws on non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(startIngest("nope")).rejects.toThrow();
  });

  it("listSources gracefully returns [] on 404 (source service not yet running)", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const sources = await listSources();
    expect(sources).toEqual([]);
  });
});
