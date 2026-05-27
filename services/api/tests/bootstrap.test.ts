import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import {
  bootstrapFrtb,
  buildFrtbSnippets,
  resolveMasterNodes,
  type RedisLike,
} from "../src/bootstrap.ts";

// Wave 5.6.3 unit suite. Drives bootstrapFrtb against an in-memory fake — no
// real Redis, no docker. Verifies: standalone runs once; cluster fans out
// across master nodes; both layers (idx:sens + frtb) are exercised; the
// second invocation is idempotent at the orchestration level (the underlying
// libs handle the redis-side idempotency, which the integration suite checks).

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, "..", "..", "..", "config", "schema", "frtb-default.yaml");

interface RecordedCall { node: string; command: string; args: unknown[] }

function fakeNode(id: string, recorded: RecordedCall[]): RedisLike {
  // Minimal subset of ioredis used by ensureSensIndex + loadFrtbLibrary.
  return {
    async call(command: string, ...args: unknown[]) {
      recorded.push({ node: id, command: String(command).toUpperCase(), args });
      return "OK";
    },
  } as unknown as RedisLike;
}

function fakeStandalone(recorded: RecordedCall[]): RedisLike {
  return fakeNode("standalone", recorded);
}

function fakeCluster(nodeIds: string[], recorded: RecordedCall[]): RedisLike {
  const nodes = nodeIds.map((id) => fakeNode(id, recorded));
  return { nodes: (_role: string) => nodes } as unknown as RedisLike;
}

describe("bootstrap — buildFrtbSnippets", () => {
  it("returns exactly the 6 locked function names in build order", () => {
    const schema = loadSchema(SCHEMA_PATH);
    const snippets = buildFrtbSnippets(schema);
    expect(snippets.map((s) => s.name)).toEqual([
      "sbm_delta_bucket",
      "sbm_vega_bucket",
      "equity_delta",
      "equity_vega",
      "fx_delta",
      "fx_vega",
    ]);
  });
});

describe("bootstrap — resolveMasterNodes", () => {
  it("returns [client] in standalone mode (no .nodes method)", () => {
    const recorded: RecordedCall[] = [];
    const r = fakeStandalone(recorded);
    expect(resolveMasterNodes(r)).toHaveLength(1);
    expect(resolveMasterNodes(r)[0]).toBe(r);
  });

  it("returns client.nodes('master') in cluster mode", () => {
    const recorded: RecordedCall[] = [];
    const c = fakeCluster(["m1", "m2"], recorded);
    expect(resolveMasterNodes(c)).toHaveLength(2);
  });
});

describe("bootstrap — bootstrapFrtb (standalone)", () => {
  it("runs FT.CREATE once and FUNCTION LOAD once and logs nodes:1", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    const r = fakeStandalone(recorded);
    const logs: Record<string, unknown>[] = [];
    const result = await bootstrapFrtb(r, schema, (e) => logs.push(e));

    const ftCreate = recorded.filter((c) => c.command === "FT.CREATE");
    const funcLoad = recorded.filter((c) => c.command === "FUNCTION");
    expect(ftCreate).toHaveLength(1);
    expect(funcLoad).toHaveLength(1);
    expect(result.index.nodes).toBe(1);
    expect(result.functions.functions).toEqual([
      "sbm_delta_bucket",
      "sbm_vega_bucket",
      "equity_delta",
      "equity_vega",
      "fx_delta",
      "fx_vega",
    ]);

    expect(logs).toEqual([
      { service: "api", bootstrap: "idx:sens", action: "created", nodes: 1 },
      {
        service: "api",
        bootstrap: "frtb",
        action: "loaded",
        nodes: 1,
        functions: result.functions.functions,
      },
    ]);
  });
});

describe("bootstrap — bootstrapFrtb (cluster fan-out)", () => {
  it("fans FT.CREATE + FUNCTION LOAD to every master node", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    const c = fakeCluster(["m1", "m2"], recorded);
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e));

    const ftCreatesPerNode = new Map<string, number>();
    const funcLoadsPerNode = new Map<string, number>();
    for (const r of recorded) {
      if (r.command === "FT.CREATE") ftCreatesPerNode.set(r.node, (ftCreatesPerNode.get(r.node) ?? 0) + 1);
      if (r.command === "FUNCTION") funcLoadsPerNode.set(r.node, (funcLoadsPerNode.get(r.node) ?? 0) + 1);
    }
    expect(ftCreatesPerNode.get("m1")).toBe(1);
    expect(ftCreatesPerNode.get("m2")).toBe(1);
    expect(funcLoadsPerNode.get("m1")).toBe(1);
    expect(funcLoadsPerNode.get("m2")).toBe(1);
    expect(logs[0]).toMatchObject({ bootstrap: "idx:sens", nodes: 2 });
    expect(logs[1]).toMatchObject({ bootstrap: "frtb", nodes: 2 });
  });
});

describe("bootstrap — idempotent at the orchestration layer", () => {
  it("a second invocation issues the same call shape (libs handle redis-side idempotency)", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    const r = fakeStandalone(recorded);
    await bootstrapFrtb(r, schema, () => undefined);
    const after1 = recorded.length;
    await bootstrapFrtb(r, schema, () => undefined);
    // Both runs make the same number of calls — no extra "is it there?" probes.
    expect(recorded.length).toBe(after1 * 2);
    // FUNCTION LOAD uses REPLACE on every call so the second is non-fatal.
    const funcArgs = recorded.filter((c) => c.command === "FUNCTION").map((c) => c.args[0]);
    expect(funcArgs.every((a) => a === "LOAD")).toBe(true);
    const funcReplace = recorded.filter((c) => c.command === "FUNCTION").map((c) => c.args[1]);
    expect(funcReplace.every((a) => a === "REPLACE")).toBe(true);
  });
});
