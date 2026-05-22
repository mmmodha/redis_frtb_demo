import { describe, it, expect, afterEach } from "vitest";
import { postCalcSbm, type CalcSbmRequest, type CalcSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return handler(input, init);
  }) as typeof fetch;
  return calls;
}

const sampleResponse: CalcSbmResponse = {
  charge: 1234.5,
  per_bucket: [
    { bucket: "USD-IRS", K_b: 100, S_b: 80, count: 1000, ms: 12 },
    { bucket: "EUR-IRS", K_b: 50, S_b: 40, count: 500, ms: 8 },
  ],
  total_ms: 42.5,
  shard_breakdown: [
    { shard: "USD-IRS", buckets: ["USD-IRS"], ms: 12 },
    { shard: "EUR-IRS", buckets: ["EUR-IRS"], ms: 8 },
  ],
  fanout_ms: 14.2,
};

describe("postCalcSbm", () => {
  it("POSTs to /calc/sbm with the given body", async () => {
    const calls = mockFetch(async () =>
      new Response(JSON.stringify(sampleResponse), {
        headers: { "content-type": "application/json" },
      }),
    );
    const body: CalcSbmRequest = { risk_class: "GIRR", sensitivity_type: "Delta" };
    const result = await postCalcSbm(body);
    expect(result.charge).toBe(1234.5);
    expect(calls[0]?.url).toMatch(/\/calc\/sbm$/);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify(body));
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("throws when the api returns a non-2xx status", async () => {
    mockFetch(async () => new Response("boom", { status: 500 }));
    await expect(
      postCalcSbm({ risk_class: "GIRR", sensitivity_type: "Delta" }),
    ).rejects.toThrow();
  });

  it("throws when the api returns a 4xx with json error body", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ error: "bad input" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      postCalcSbm({ risk_class: "GIRR", sensitivity_type: "Bogus" as "Delta" }),
    ).rejects.toThrow(/bad input/);
  });
});
