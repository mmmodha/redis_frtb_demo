// Wave 7.0.6.5 — Unit/smoke tests for scripts/connection-spread-probe.mjs.
//
// Exercises runProbe() with a fake ioredis-shaped client factory so we can
// validate JSON shape, success / failure paths, and the per-connection
// timeout without standing up a real Redis.

import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs sibling without typings; runtime shape is documented.
import { parseArgs, runProbe } from "../../../scripts/connection-spread-probe.mjs";

type FakeCall = (cmd: string, ...args: string[]) => Promise<unknown>;
interface FakeClient { call: FakeCall; quit: () => Promise<void> }

function makeFakeClient(id: number): FakeClient {
  return {
    call: async (cmd: string) => {
      if (cmd === "CLIENT") return id; // CLIENT ID / CLIENT SETNAME both pass through here
      return "OK";
    },
    quit: async () => undefined,
  };
}

describe("connection-spread-probe · parseArgs", () => {
  it("applies documented defaults", () => {
    const a = parseArgs(["--endpoint", "redis.example.com:12000"]);
    expect(a.connections).toBe(32);
    expect(a.tolerance).toBe(0.20);
    expect(a.timeoutMs).toBe(5000);
    expect(a.endpoint).toBe("redis.example.com:12000");
  });

  it("parses overrides", () => {
    const a = parseArgs([
      "--endpoint", "h:1", "--connections", "4",
      "--tolerance", "0.1", "--timeout-ms", "1000",
    ]);
    expect(a.connections).toBe(4);
    expect(a.tolerance).toBe(0.1);
    expect(a.timeoutMs).toBe(1000);
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--unknown"])).toThrow(/unknown flag/);
  });
});

describe("connection-spread-probe · runProbe", () => {
  it("emits one row per connection with client_id + client_name", async () => {
    const N = 8;
    const createClient = (i: number, _name: string) => makeFakeClient(100 + i);
    const report = await runProbe({ connections: N, timeoutMs: 1000, createClient });

    expect(report.requested).toBe(N);
    expect(report.established).toBe(N);
    expect(report.failed).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.connections).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      const row = report.connections[i];
      expect(row.index).toBe(i);
      expect(row.client_id).toBe(100 + i);
      expect(row.client_name).toBe(`${report.probe_tag}-${i}`);
    }
    expect(typeof report.elapsed_ms).toBe("number");
    expect(report.probe_tag).toMatch(/^csprobe-\d+-\d+$/);
  });

  it("records failures when a connection rejects", async () => {
    const createClient = (i: number) => {
      if (i === 2) throw new Error("ECONNREFUSED");
      return makeFakeClient(100 + i);
    };
    const report = await runProbe({ connections: 4, timeoutMs: 500, createClient });
    expect(report.established).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.failures[0].index).toBe(2);
    expect(report.failures[0].error).toMatch(/ECONNREFUSED/);
  });

  it("times out CLIENT ID that never resolves", async () => {
    const createClient = (): FakeClient => ({
      // CLIENT ID never resolves — runProbe should time out within timeoutMs.
      call: () => new Promise(() => { /* hang forever */ }),
      quit: async () => undefined,
    });
    const report = await runProbe({ connections: 2, timeoutMs: 50, createClient });
    expect(report.established).toBe(0);
    expect(report.failed).toBe(2);
    for (const f of report.failures) expect(f.error).toMatch(/timeout/);
  });
});
