// RED — concurrent load runner contract.
//
// The Runner owns N worker loops that pick an endpoint per the configured
// pivot/calc mix and fire it against the api, recording latency + outcome.
// Tests inject a mock `fetch` so we never hit the network.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Runner, type RunnerConfig } from "../src/runner.ts";

afterEach(() => {
  vi.useRealTimers();
});

const baseCfg: Partial<RunnerConfig> = {
  concurrency: 2,
  duration_sec: 60,
  api_base: "http://stub.invalid",
};

describe("Runner lifecycle", () => {
  it("starts in 'idle' status", () => {
    const r = new Runner();
    expect(r.status()).toBe("idle");
  });

  it("transitions to 'running' on start(), 'stopped' after stop()", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = new Runner();
    r.start({ ...baseCfg, mix: { pivot: 1, calc: 0 }, fetch: fetchMock });
    expect(r.status()).toBe("running");
    await new Promise((res) => setTimeout(res, 20));
    await r.stop();
    expect(r.status()).toBe("stopped");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("stop() is idempotent — calling twice does not throw", async () => {
    const r = new Runner();
    r.start({ ...baseCfg, mix: { pivot: 1, calc: 0 }, fetch: vi.fn(async () => new Response("{}")) });
    await r.stop();
    await expect(r.stop()).resolves.toBeUndefined();
  });

  it("start() while running re-configures cleanly (returns 'running')", async () => {
    const r = new Runner();
    r.start({ ...baseCfg, mix: { pivot: 1, calc: 0 }, fetch: vi.fn(async () => new Response("{}")) });
    expect(r.status()).toBe("running");
    r.start({ ...baseCfg, concurrency: 4, mix: { pivot: 0, calc: 1 }, fetch: vi.fn(async () => new Response("{}")) });
    expect(r.status()).toBe("running");
    await r.stop();
  });
});

describe("Runner metrics + snapshot", () => {
  it("snapshot() before start has running=false and both endpoint blocks zeroed", () => {
    const r = new Runner();
    const snap = r.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.total_requests).toBe(0);
    expect(snap.per_endpoint.pivot).toEqual({ count: 0, errors: 0, p50: 0, p95: 0, p99: 0 });
    expect(snap.per_endpoint.calc).toEqual({ count: 0, errors: 0, p50: 0, p95: 0, p99: 0 });
  });

  it("counts errors when fetch resolves with a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const r = new Runner();
    r.start({ ...baseCfg, mix: { pivot: 1, calc: 0 }, fetch: fetchMock });
    await new Promise((res) => setTimeout(res, 25));
    await r.stop();
    const snap = r.snapshot();
    expect(snap.errors).toBeGreaterThan(0);
    expect(snap.per_endpoint.pivot.errors).toBeGreaterThan(0);
  });

  it("counts errors when fetch rejects (network error)", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("boom"); });
    const r = new Runner();
    r.start({ ...baseCfg, mix: { pivot: 1, calc: 0 }, fetch: fetchMock });
    await new Promise((res) => setTimeout(res, 25));
    await r.stop();
    const snap = r.snapshot();
    expect(snap.errors).toBeGreaterThan(0);
  });
});

describe("Runner endpoint mix", () => {
  it("mix { pivot:1, calc:0 } only fires the /pivot URL", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response("{}");
    });
    const r = new Runner();
    r.start({ ...baseCfg, mix: { pivot: 1, calc: 0 }, fetch: fetchMock });
    await new Promise((res) => setTimeout(res, 30));
    await r.stop();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.includes("/pivot"))).toBe(true);
  });

  it("mix { pivot:0, calc:1 } only fires the /calc/sbm URL", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response("{}");
    });
    const r = new Runner();
    r.start({ ...baseCfg, mix: { pivot: 0, calc: 1 }, fetch: fetchMock });
    await new Promise((res) => setTimeout(res, 30));
    await r.stop();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.includes("/calc"))).toBe(true);
  });

  it("a 50/50 mix produces both endpoints within ~30ms of fan-out", async () => {
    const seen = new Set<string>();
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/pivot")) seen.add("pivot");
      else if (u.includes("/calc")) seen.add("calc");
      return new Response("{}");
    });
    const r = new Runner();
    r.start({ ...baseCfg, concurrency: 8, mix: { pivot: 1, calc: 1 }, fetch: fetchMock });
    await new Promise((res) => setTimeout(res, 50));
    await r.stop();
    expect(seen.has("pivot")).toBe(true);
    expect(seen.has("calc")).toBe(true);
  });
});

describe("Runner duration cap", () => {
  it("auto-stops once duration_sec elapses without an explicit stop()", async () => {
    const r = new Runner();
    r.start({
      ...baseCfg,
      duration_sec: 0.05,
      mix: { pivot: 1, calc: 0 },
      fetch: vi.fn(async () => new Response("{}")),
    });
    await new Promise((res) => setTimeout(res, 200));
    expect(r.status()).toBe("stopped");
  });
});
