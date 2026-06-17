import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import {
  bootstrapFrtb,
  BootstrapPartialError,
  buildFrtbSnippets,
  resolveMasterNodes,
  type RedisLike,
} from "../src/bootstrap.ts";
import { computeSchemaHash } from "../src/lib/schema-hash.ts";
import {
  BASE_INDEX_NAME,
  clearSensIndexNameCache,
  getSensIndexName,
  LEGACY_HASH_PREFIX,
  schemaHashKey,
  versionedIndexName,
} from "../src/lib/sens-index.ts";
import type { RedisLike as NarrowRedisLike } from "../src/redis-like.ts";

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
  // Wave 5.30a — Step 3 SUGLEN/SUGADD route through the cluster client
  // directly (NOT per-master). The fake cluster routes those calls to the
  // first node so the recorder still picks them up under a real shard id.
  return {
    nodes: (_role: string) => nodes,
    call: (command: string, ...args: unknown[]) => (nodes[0] as { call: (c: string, ...a: unknown[]) => Promise<unknown> }).call(command, ...args),
  } as unknown as RedisLike;
}

// Wave 5.16f1: bootstrap now registers all 9 (risk_class × leg) snippets
// — the 6 Delta/Vega ones plus the 3 Curvature ones added in 5.16a/b.
const EXPECTED_SNIPPET_NAMES = [
  "sbm_delta_bucket",
  "sbm_vega_bucket",
  "equity_delta",
  "equity_vega",
  "fx_delta",
  "fx_vega",
  "girr_curvature",
  "equity_curvature",
  "fx_curvature",
];

describe("bootstrap — buildFrtbSnippets", () => {
  it("returns exactly the 9 locked function names in build order", () => {
    const schema = loadSchema(SCHEMA_PATH);
    const snippets = buildFrtbSnippets(schema);
    expect(snippets.map((s) => s.name)).toEqual(EXPECTED_SNIPPET_NAMES);
  });

  it("buildFrtbSnippets registers all 9 (risk_class × leg) function names", () => {
    const schema = loadSchema(SCHEMA_PATH);
    const snippets = buildFrtbSnippets(schema);
    expect(snippets).toHaveLength(9);
    const pattern = /^(girr|equity|fx|sbm)_(delta|vega|curvature)(_bucket)?$/;
    for (const snip of snippets) {
      expect(snip.name).toMatch(pattern);
    }
    // Set-equality check independent of build order — catches both missing
    // entries (regression) and duplicates.
    expect(new Set(snippets.map((snip) => snip.name))).toEqual(new Set(EXPECTED_SNIPPET_NAMES));
  });

  // Wave 5.83G — fx_delta snippet must substitute the schema's fx_rho into
  // __FX_DELTA_RHO__. The buildFxDeltaSnippet default of 0 silently mis-wires
  // the Lua kernel to K_b = √Σws² (single-factor specialisation) while the
  // FT.AGGREGATE fast path uses fx_rho=0.60 via resolveRho — the source of
  // the 5.83E divergence (3.869 vs 2.370 on the live 20k FX corpus).
  it("fx_delta snippet substitutes schema fx_rho (not 0) into __FX_DELTA_RHO__", () => {
    const schema = loadSchema(SCHEMA_PATH);
    const snippets = buildFrtbSnippets(schema);
    const fx = snippets.find((s) => s.name === "fx_delta");
    expect(fx).toBeDefined();
    const fxRhoSpec = schema.correlations.fx_rho;
    expect(fxRhoSpec?.kind).toBe("constant");
    const fxRho = (fxRhoSpec as { kind: "constant"; value: number }).value;
    expect(fxRho).toBeGreaterThan(0);
    // The substitution token must be gone and the rho assignment must carry
    // the schema literal. Match `local rho = <number>` so a stray 0 default
    // fails the assertion loudly.
    expect(fx!.code).not.toContain("__FX_DELTA_RHO__");
    const rhoMatch = fx!.code.match(/local\s+rho\s*=\s*([0-9eE+\-.]+)/);
    expect(rhoMatch, "fx_delta snippet must contain `local rho = <number>`").toBeTruthy();
    expect(Number(rhoMatch![1])).toBeCloseTo(fxRho, 12);
  });

  // Wave 5.83J2 — same wiring rule as fx_delta above, applied to fx_vega.
  // resolveRho() returns fx_rho for FX Vega (no separate fx_vega_rho spec),
  // so the Lua kernel must carry the schema literal too — otherwise K_b
  // collapses to √Σws² and the live 200k parity sweep diverges (8.6% gap
  // observed in 5.83I before this fix landed alongside the 5.83G Delta wire).
  it("fx_vega snippet substitutes schema fx_rho (not 0) into __FX_VEGA_RHO__", () => {
    const schema = loadSchema(SCHEMA_PATH);
    const snippets = buildFrtbSnippets(schema);
    const fx = snippets.find((s) => s.name === "fx_vega");
    expect(fx).toBeDefined();
    const fxRhoSpec = schema.correlations.fx_rho;
    expect(fxRhoSpec?.kind).toBe("constant");
    const fxRho = (fxRhoSpec as { kind: "constant"; value: number }).value;
    expect(fxRho).toBeGreaterThan(0);
    expect(fx!.code).not.toContain("__FX_VEGA_RHO__");
    const rhoMatch = fx!.code.match(/local\s+rho\s*=\s*([0-9eE+\-.]+)/);
    expect(rhoMatch, "fx_vega snippet must contain `local rho = <number>`").toBeTruthy();
    expect(Number(rhoMatch![1])).toBeCloseTo(fxRho, 12);
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
    expect(result.functions.functions).toEqual(EXPECTED_SNIPPET_NAMES);

    expect(logs).toEqual([
      { service: "api", bootstrap: "idx:sens", action: "created", nodes: 1 },
      {
        service: "api",
        bootstrap: "frtb",
        action: "loaded",
        nodes: 1,
        functions: result.functions.functions,
      },
      {
        service: "api",
        bootstrap: "suggesters",
        action: "backfilled",
        counts: { book: 0, trade_id: 0, risk_factor: 0 },
      },
    ]);
  });
});

// Wave 5.30a — Step 3 backfill suite. Drives bootstrapFrtb against a fake
// that returns canned FT.AGGREGATE replies for each suggester field, then
// asserts the right SUGLEN/SUGADD argv lands on the client.
function fakeStandaloneWithReplies(
  recorded: RecordedCall[],
  replies: Record<string, unknown>,
): RedisLike {
  return {
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: "standalone", command: cmd, args });
      if (cmd === "FT.AGGREGATE") {
        const field = String(args[4] ?? "").replace(/^@/, "");
        return replies[`agg:${field}`] ?? "OK";
      }
      if (cmd === "FT.SUGLEN") return replies[`len:${String(args[0])}`] ?? 0;
      return "OK";
    },
  } as unknown as RedisLike;
}

describe("bootstrap — Step 3 backfill suggesters", () => {
  it("issues FT.SUGADD once per distinct value per field and logs the counts", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    const r = fakeStandaloneWithReplies(recorded, {
      // FT.AGGREGATE reply layout: [total, [field, value], [field, value], ...]
      "agg:book": [3, ["book", "BOOK-A"], ["book", "BOOK-B"], ["book", "BOOK-C"]],
      "agg:trade_id": [2, ["trade_id", "T0001"], ["trade_id", "T0002"]],
      "agg:risk_factor": [1, ["risk_factor", "RF_GIRR_01"]],
      "len:sug:book": 0,
      "len:sug:trade_id": 0,
      "len:sug:risk_factor": 0,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(r, schema, (e) => logs.push(e));

    const sugadds = recorded.filter((c) => c.command === "FT.SUGADD");
    expect(sugadds).toHaveLength(6);
    const bookValues = sugadds.filter((c) => c.args[0] === "sug:book").map((c) => c.args[1]);
    expect(bookValues.sort()).toEqual(["BOOK-A", "BOOK-B", "BOOK-C"]);
    const tradeValues = sugadds.filter((c) => c.args[0] === "sug:trade_id").map((c) => c.args[1]);
    expect(tradeValues.sort()).toEqual(["T0001", "T0002"]);
    const factorValues = sugadds.filter((c) => c.args[0] === "sug:risk_factor").map((c) => c.args[1]);
    expect(factorValues).toEqual(["RF_GIRR_01"]);
    // Every SUGADD writes a score of "1" (no INCR — replace semantics so the
    // backfill is idempotent on re-run).
    for (const c of sugadds) expect(c.args[2]).toBe("1");

    const last = logs[logs.length - 1]!;
    expect(last).toMatchObject({
      bootstrap: "suggesters",
      action: "backfilled",
      counts: { book: 3, trade_id: 2, risk_factor: 1 },
    });

    // Wave 5.41: every suggester FT.AGGREGATE carries an explicit TIMEOUT
    // 30000 so a cold-cache backfill at 1M+ rows cannot hang bootstrap
    // behind the module's implicit default.
    const aggs = recorded.filter((c) => c.command === "FT.AGGREGATE");
    expect(aggs.length).toBeGreaterThan(0);
    for (const agg of aggs) {
      const ti = agg.args.indexOf("TIMEOUT");
      expect(ti).toBeGreaterThan(-1);
      expect(agg.args[ti + 1]).toBe("30000");
    }
  });

  it("skips FT.AGGREGATE/FT.SUGADD when FT.SUGLEN reports a populated dictionary (idempotent on restart)", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    const r = fakeStandaloneWithReplies(recorded, {
      "len:sug:book": 5,
      "len:sug:trade_id": 7,
      "len:sug:risk_factor": 3,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(r, schema, (e) => logs.push(e));

    expect(recorded.filter((c) => c.command === "FT.SUGADD")).toHaveLength(0);
    // Wave 6.14c — Step 4 always issues one FT.AGGREGATE for the rollup
    // completeness check (GROUPBY @risk_class @bucket). The suggester
    // backfill path is still fully skipped here (zero suggester aggregates).
    const aggs = recorded.filter((c) => c.command === "FT.AGGREGATE");
    const suggesterAggs = aggs.filter((c) => !(c.args.includes("@risk_class") && c.args.includes("@bucket")));
    expect(suggesterAggs).toHaveLength(0);
    const suggLog = logs.find((l) => l.bootstrap === "suggesters")!;
    expect(suggLog).toMatchObject({
      bootstrap: "suggesters",
      action: "backfilled",
      counts: { book: 5, trade_id: 7, risk_factor: 3 },
    });
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

// Wave 6.16a — per-node failure tracking. One node throws on FT.CREATE
// (or FUNCTION LOAD); the other nodes succeed. bootstrapFrtb must
// collect those tuples instead of fire-and-failing on the first throw
// and surface them via BootstrapPartialError so callers can publish a
// `partial` status flag instead of a false `ready`.
function fakeClusterWithFailingNode(opts: {
  nodes: string[];
  failingNode: string;
  failOn: string; // command to reject on the failing node
  failError: string;
}): { client: RedisLike; recorded: RecordedCall[] } {
  const recorded: RecordedCall[] = [];
  const nodeImpls = opts.nodes.map((id) => ({
    id,
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: id, command: cmd, args });
      if (id === opts.failingNode && cmd === opts.failOn.toUpperCase()) {
        throw new Error(opts.failError);
      }
      return "OK";
    },
  }));
  const client = {
    nodes: (_role: string) => nodeImpls as unknown as RedisLike[],
    call: (command: string, ...args: unknown[]) =>
      (nodeImpls[0] as { call: (c: string, ...a: unknown[]) => Promise<unknown> })
        .call(command, ...args),
  } as unknown as RedisLike;
  return { client, recorded };
}

describe("bootstrap — Wave 6.16a per-node failure tracking", () => {
  it("throws BootstrapPartialError with failures=[{step:'idx:sens',node_id:'node-0',...}] when node-0's FT.CREATE rejects", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    // Wave 6.16a — error string must NOT match the "already exists" /
    // "unknown index" swallowing logic in @frtb/rqe, otherwise
    // ensureSensIndex / dropSensIndex absorb the throw and the partial
    // path never trips.
    const { client } = fakeClusterWithFailingNode({
      nodes: ["m1", "m2"],
      failingNode: "m1",
      failOn: "FT.CREATE",
      failError: "OOM command not allowed when used memory > maxmemory",
    });
    try {
      await bootstrapFrtb(client, schema, () => undefined);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BootstrapPartialError);
      const failures = (e as BootstrapPartialError).failures;
      expect(failures).toEqual([
        {
          step: "idx:sens",
          node_id: "node-0",
          error: "OOM command not allowed when used memory > maxmemory",
        },
      ]);
    }
  });

  it("continues past a failing node so healthy nodes still receive FT.CREATE + FUNCTION LOAD", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const { client, recorded } = fakeClusterWithFailingNode({
      nodes: ["m1", "m2", "m3"],
      failingNode: "m2",
      failOn: "FT.CREATE",
      failError: "OOM not enough memory",
    });
    await expect(bootstrapFrtb(client, schema, () => undefined)).rejects.toThrow(
      BootstrapPartialError,
    );
    const ftCreates = recorded.filter((c) => c.command === "FT.CREATE");
    // All three nodes were attempted (per-node loop did not abort on m2).
    expect(ftCreates.map((c) => c.node).sort()).toEqual(["m1", "m2", "m3"]);
    // Step 2 still ran against all three nodes despite Step 1 failing on m2.
    const funcLoads = recorded.filter((c) => c.command === "FUNCTION");
    expect(funcLoads.map((c) => c.node).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("records frtb step failure under node_id matching node ordering", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const { client } = fakeClusterWithFailingNode({
      nodes: ["m1", "m2"],
      failingNode: "m2",
      failOn: "FUNCTION",
      failError: "OOM",
    });
    try {
      await bootstrapFrtb(client, schema, () => undefined);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BootstrapPartialError);
      const failures = (e as BootstrapPartialError).failures;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ step: "frtb", node_id: "node-1" });
      expect(failures[0]!.error).toContain("OOM");
    }
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

// Wave 6.14c — Step 4 rollup completeness sanity check. When the discovery
// FT.AGGREGATE finds (rc, bkt) buckets but the SCAN over `rollup:{*}:*` keys
// turns up a smaller distinct hash-tag count, bootstrap emits a single
// non-fatal WARN log entry pointing operators at the backfill tool. No log
// line is emitted on the healthy path so the existing standalone log shape
// is unchanged when no docs / no rollups are present.
function fakeStandaloneWithRollupShortfall(
  recorded: RecordedCall[],
  opts: { buckets: string[]; rollupHashtags: string[] },
): RedisLike {
  // FT.AGGREGATE GROUPBY 2 @risk_class @bucket reply rows interleave
  // (field, value, field, value) pairs — match the layout the bootstrap
  // loop parses. The first array element is the row count.
  const rcBktRows = opts.buckets.map((b) => {
    const [rc, bkt] = b.split(":");
    return ["risk_class", rc, "bucket", bkt];
  });
  const rcBktReply: unknown[] = [opts.buckets.length, ...rcBktRows];
  // SCAN reply is [cursor, [keys]]. One sweep returns the configured set
  // of rollup keys, then a "0" cursor terminates the do/while loop.
  let scanCalls = 0;
  return {
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: "standalone", command: cmd, args });
      if (cmd === "FT.AGGREGATE") {
        const groupbyFields = args.slice(args.indexOf("GROUPBY") + 2, args.indexOf("LIMIT"));
        const isRollupCheck = groupbyFields.includes("@risk_class") && groupbyFields.includes("@bucket");
        if (isRollupCheck) return rcBktReply;
        return [0];
      }
      if (cmd === "FT.SUGLEN") return 1;
      if (cmd === "SCAN") {
        scanCalls += 1;
        if (scanCalls === 1) {
          const keys = opts.rollupHashtags.map((ht) => `rollup:{${ht}}:Delta`);
          return ["0", keys];
        }
        return ["0", []];
      }
      return "OK";
    },
  } as unknown as RedisLike;
}

describe("bootstrap — Wave 6.14c rollup completeness WARN", () => {
  it("emits a single WARN log when rollup hashtag count < discovered bucket count", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    // 3 distinct (rc, bkt) buckets vs. 2 rollup hashtags → 1 short.
    const r = fakeStandaloneWithRollupShortfall(recorded, {
      buckets: ["EQUITY:1", "EQUITY:5", "GIRR:USD-IRS"],
      rollupHashtags: ["EQUITY:1", "EQUITY:5"],
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(r, schema, (e) => logs.push(e));

    const warns = logs.filter((l) => l.bootstrap === "rollups");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      service: "api",
      bootstrap: "rollups",
      action: "incomplete",
      level: "warn",
      buckets: 3,
      rollup_buckets: 2,
    });
  });

  it("emits NO rollup log when rollup hashtag count >= discovered bucket count", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    const r = fakeStandaloneWithRollupShortfall(recorded, {
      buckets: ["EQUITY:1", "EQUITY:5"],
      rollupHashtags: ["EQUITY:1", "EQUITY:5"],
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(r, schema, (e) => logs.push(e));
    expect(logs.some((l) => l.bootstrap === "rollups")).toBe(false);
  });

  it("emits NO rollup log when no buckets are discovered (cold start)", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const recorded: RecordedCall[] = [];
    const r = fakeStandaloneWithRollupShortfall(recorded, { buckets: [], rollupHashtags: [] });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(r, schema, (e) => logs.push(e));
    expect(logs.some((l) => l.bootstrap === "rollups")).toBe(false);
  });
});

// Wave 6.18i — fake cluster with selectable GET (schema-hash key) + FT.INFO
// behaviours so the skip / drop / missing-index recovery paths can be
// exercised without booting RediSearch. Returns "OK" for everything else so
// Steps 2-4 keep their existing per-master loop semantics.
interface HashClusterOpts {
  oldHash: string | null;          // canned GET reply for schemaHashKey
  indexPresent: boolean;            // FT.INFO succeeds (true) or throws (false)
}
function fakeClusterWithHash(
  nodeIds: string[],
  recorded: RecordedCall[],
  opts: HashClusterOpts,
): RedisLike {
  const setHash = { value: opts.oldHash };
  const nodes = nodeIds.map((id) => ({
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: id, command: cmd, args });
      if (cmd === "FT.INFO") {
        if (!opts.indexPresent) throw new Error("Unknown Index name");
        return ["index_name", String(args[0])];
      }
      return "OK";
    },
  }));
  return {
    nodes: (_role: string) => nodes as unknown as RedisLike[],
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: "cluster", command: cmd, args });
      if (cmd === "GET") return setHash.value;
      if (cmd === "SET") { setHash.value = String(args[1]); return "OK"; }
      // Step 3 SUGLEN — return >0 so the suggester backfill short-circuits
      // and the recorded-call assertions stay focused on Step 1.
      if (cmd === "FT.SUGLEN") return 1;
      if (cmd === "FT.AGGREGATE") return [0];
      return "OK";
    },
  } as unknown as RedisLike;
}

describe("bootstrap — Wave 6.18i schema-hash skip + ASYNC drop", () => {
  it("skip path: matching hash + index present on every master → no FT.CREATE / FT.DROPINDEX, logs bootstrap-skip", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    const c = fakeClusterWithHash(["m1", "m2"], recorded, {
      oldHash: newHash,
      indexPresent: true,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-A" });

    expect(recorded.some((r) => r.command === "FT.CREATE")).toBe(false);
    expect(recorded.some((r) => r.command === "FT.DROPINDEX")).toBe(false);
    const skip = logs.find((l) => l.action === "bootstrap-skip");
    expect(skip).toMatchObject({
      bootstrap: "idx:sens",
      action: "bootstrap-skip",
      reason: "schema-unchanged",
      index: versionedIndexName(newHash),
      nodes: 2,
    });
    // Skip path returns early — Step 2 (frtb library) is not run.
    expect(recorded.some((r) => r.command === "FUNCTION")).toBe(false);
  });

  it("drop path: hash mismatch → FT.DROPINDEX ASYNC on old name + FT.CREATE on new versioned name + SET hash key", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const oldHash = "deadbeefdeadbeef";
    const recorded: RecordedCall[] = [];
    const c = fakeClusterWithHash(["m1", "m2"], recorded, {
      oldHash,
      indexPresent: true,
    });
    await bootstrapFrtb(c, schema, () => undefined, { target_label: "tgt-B" });

    // Per-master DROPINDEX of the OLD versioned name, with ASYNC flag.
    const drops = recorded.filter((r) => r.command === "FT.DROPINDEX");
    expect(drops).toHaveLength(2);
    for (const d of drops) {
      expect(d.args[0]).toBe(versionedIndexName(oldHash));
      expect(d.args[1]).toBe("ASYNC");
    }
    // Per-master CREATE of the NEW versioned name.
    const creates = recorded.filter((r) => r.command === "FT.CREATE");
    expect(creates).toHaveLength(2);
    for (const c2 of creates) {
      expect(c2.args[0]).toBe(versionedIndexName(newHash));
    }
    // Hash key is SET to the new hash on the cluster client.
    const sets = recorded.filter((r) => r.command === "SET" && r.args[0] === schemaHashKey("tgt-B"));
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args[1]).toBe(newHash);
  });

  it("missing-index recovery: hash matches but FT.INFO throws → falls back to full rebuild", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    const c = fakeClusterWithHash(["m1", "m2"], recorded, {
      oldHash: newHash,            // hash matches
      indexPresent: false,         // …but FT.INFO probe fails
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-C" });

    // No skip log — fell through to the rebuild branch.
    expect(logs.some((l) => l.action === "bootstrap-skip")).toBe(false);
    // FT.CREATE issued on every master under the versioned name.
    const creates = recorded.filter((r) => r.command === "FT.CREATE");
    expect(creates).toHaveLength(2);
    for (const c2 of creates) {
      expect(c2.args[0]).toBe(versionedIndexName(newHash));
    }
    // Old==new versioned name → DROPINDEX is suppressed to avoid wiping
    // the index we are about to (re)create.
    expect(recorded.some((r) => r.command === "FT.DROPINDEX")).toBe(false);
  });

  it("hash stability: reordering top-level + nested keys yields the same fingerprint", () => {
    const baseSchema = loadSchema(SCHEMA_PATH);
    const reordered: Record<string, unknown> = {};
    const keys = Object.keys(baseSchema as unknown as Record<string, unknown>);
    // Insert in reverse order so the JSON serialisation differs byte-wise
    // from the canonical-sorted form until computeSchemaHash deep-sorts it.
    for (const k of keys.reverse()) {
      reordered[k] = (baseSchema as unknown as Record<string, unknown>)[k];
    }
    expect(computeSchemaHash(reordered)).toBe(computeSchemaHash(baseSchema));
    // And a literal structural change still flips the hash.
    const mutated = { ...(baseSchema as unknown as Record<string, unknown>), __extra: "x" };
    expect(computeSchemaHash(mutated)).not.toBe(computeSchemaHash(baseSchema));
  });
});


// Wave 6.18j — fake cluster with selectable GET / SET / FT.INFO behaviours
// keyed on whether the FT.INFO target is the legacy `idx:sens` or any
// versioned name. `legacyDocs` drives the num_docs reply on the legacy probe
// (null → throw "Unknown Index name"). The per-master nodes also honour
// FT.INFO so the existing 6.18i indexPresentOnAll check stays satisfied for
// the plain-hex skip branch when needed.
interface AdoptClusterOpts {
  oldHash: string | null;
  legacyDocs: number | null;        // null → FT.INFO idx:sens throws
  versionedPresent?: boolean;       // FT.INFO versioned name succeeds
}
function fakeClusterForAdopt(
  nodeIds: string[],
  recorded: RecordedCall[],
  opts: AdoptClusterOpts,
): RedisLike {
  const setHash = { value: opts.oldHash };
  const versionedPresent = opts.versionedPresent !== false;
  const nodes = nodeIds.map((id) => ({
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: id, command: cmd, args });
      if (cmd === "FT.INFO") {
        if (String(args[0]) === BASE_INDEX_NAME) {
          if (opts.legacyDocs === null) throw new Error("Unknown Index name");
          return ["index_name", BASE_INDEX_NAME, "num_docs", String(opts.legacyDocs)];
        }
        if (!versionedPresent) throw new Error("Unknown Index name");
        return ["index_name", String(args[0])];
      }
      return "OK";
    },
  }));
  return {
    nodes: (_role: string) => nodes as unknown as RedisLike[],
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: "cluster", command: cmd, args });
      if (cmd === "GET") return setHash.value;
      if (cmd === "SET") { setHash.value = String(args[1]); return "OK"; }
      if (cmd === "FT.INFO") {
        if (String(args[0]) === BASE_INDEX_NAME) {
          if (opts.legacyDocs === null) throw new Error("Unknown Index name");
          return ["index_name", BASE_INDEX_NAME, "num_docs", String(opts.legacyDocs)];
        }
        if (!versionedPresent) throw new Error("Unknown Index name");
        return ["index_name", String(args[0])];
      }
      if (cmd === "FT.SUGLEN") return 1;
      if (cmd === "FT.AGGREGATE") return [0];
      return "OK";
    },
  } as unknown as RedisLike;
}

describe("bootstrap — Wave 6.18j adopt legacy idx:sens on first migration", () => {
  it("adopt-legacy: no hash key + legacy num_docs>0 → SET legacy:{hash}, no FT.CREATE, logs bootstrap-adopt-legacy", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForAdopt(["m1", "m2"], recorded, {
      oldHash: null,
      legacyDocs: 100,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-J1" });

    expect(recorded.some((r) => r.command === "FT.CREATE")).toBe(false);
    expect(recorded.some((r) => r.command === "FT.DROPINDEX")).toBe(false);
    const sets = recorded.filter(
      (r) => r.command === "SET" && r.args[0] === schemaHashKey("tgt-J1"),
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args[1]).toBe(`${LEGACY_HASH_PREFIX}${newHash}`);
    const adopt = logs.find((l) => l.action === "bootstrap-adopt-legacy");
    expect(adopt).toMatchObject({
      bootstrap: "idx:sens",
      action: "bootstrap-adopt-legacy",
      num_docs: 100,
      hash: `${LEGACY_HASH_PREFIX}${newHash}`,
    });
    // Adoption short-circuits Steps 2-4 just like the schema-unchanged skip.
    expect(recorded.some((r) => r.command === "FUNCTION")).toBe(false);
  });

  it("adopt-legacy-skipped-on-empty: no hash key + legacy num_docs=0 → falls through to versioned-create path", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForAdopt(["m1", "m2"], recorded, {
      oldHash: null,
      legacyDocs: 0,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-J2" });

    // No adoption — we fall through to the standard create-versioned branch.
    expect(logs.some((l) => l.action === "bootstrap-adopt-legacy")).toBe(false);
    const creates = recorded.filter((r) => r.command === "FT.CREATE");
    expect(creates).toHaveLength(2);
    for (const c2 of creates) expect(c2.args[0]).toBe(versionedIndexName(newHash));
    const sets = recorded.filter(
      (r) => r.command === "SET" && r.args[0] === schemaHashKey("tgt-J2"),
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args[1]).toBe(newHash);  // plain, no legacy prefix
  });

  it("adopt-legacy-skipped-when-missing: no hash key + FT.INFO idx:sens throws → falls through to versioned-create path", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForAdopt(["m1", "m2"], recorded, {
      oldHash: null,
      legacyDocs: null,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-J3" });

    expect(logs.some((l) => l.action === "bootstrap-adopt-legacy")).toBe(false);
    const creates = recorded.filter((r) => r.command === "FT.CREATE");
    expect(creates).toHaveLength(2);
    for (const c2 of creates) expect(c2.args[0]).toBe(versionedIndexName(newHash));
  });

  it("legacy-skip-unchanged: hash key = legacy:{currentHash} → no FT.CREATE/FT.DROPINDEX, logs legacy-schema-unchanged", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForAdopt(["m1", "m2"], recorded, {
      oldHash: `${LEGACY_HASH_PREFIX}${newHash}`,
      legacyDocs: 100,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-J4" });

    expect(recorded.some((r) => r.command === "FT.CREATE")).toBe(false);
    expect(recorded.some((r) => r.command === "FT.DROPINDEX")).toBe(false);
    const skip = logs.find((l) => l.action === "bootstrap-skip");
    expect(skip).toMatchObject({
      bootstrap: "idx:sens",
      action: "bootstrap-skip",
      reason: "legacy-schema-unchanged",
      index: BASE_INDEX_NAME,
    });
    // Steps 2-4 are skipped on the legacy-unchanged path just like 6.18i skip.
    expect(recorded.some((r) => r.command === "FUNCTION")).toBe(false);
  });

  it("legacy-migrate-on-change: hash key = legacy:{old} with old≠newHash → DROPINDEX idx:sens ASYNC + CREATE versioned + SET plain newHash", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const staleHash = "deadbeefdeadbeef";
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForAdopt(["m1", "m2"], recorded, {
      oldHash: `${LEGACY_HASH_PREFIX}${staleHash}`,
      legacyDocs: 100,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-J5" });

    // Per-master DROPINDEX of the LITERAL legacy name (not a versioned one)
    // with ASYNC flag.
    const drops = recorded.filter((r) => r.command === "FT.DROPINDEX");
    expect(drops).toHaveLength(2);
    for (const d of drops) {
      expect(d.args[0]).toBe(BASE_INDEX_NAME);
      expect(d.args[1]).toBe("ASYNC");
    }
    // Per-master CREATE of the NEW versioned name.
    const creates = recorded.filter((r) => r.command === "FT.CREATE");
    expect(creates).toHaveLength(2);
    for (const c2 of creates) expect(c2.args[0]).toBe(versionedIndexName(newHash));
    // Hash key rewritten to plain newHash (no legacy prefix) so the next
    // restart follows the standard 6.18i versioned-path semantics.
    const sets = recorded.filter(
      (r) => r.command === "SET" && r.args[0] === schemaHashKey("tgt-J5"),
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args[1]).toBe(newHash);
    expect((sets[0]!.args[1] as string).startsWith(LEGACY_HASH_PREFIX)).toBe(false);
    // Migration log line is emitted (instead of "created" or "skip").
    const mig = logs.find((l) => l.action === "bootstrap-migrate-legacy-to-versioned");
    expect(mig).toMatchObject({
      bootstrap: "idx:sens",
      action: "bootstrap-migrate-legacy-to-versioned",
      oldIndex: BASE_INDEX_NAME,
      newIndex: versionedIndexName(newHash),
    });
  });

  it("helper-returns-literal-for-legacy: getSensIndexName returns \"idx:sens\" when hash key starts with legacy:", async () => {
    clearSensIndexNameCache();
    const hash = "abcdef1234567890";
    const fake = {
      async call(command: string, ..._args: unknown[]) {
        if (String(command).toUpperCase() === "GET") return `${LEGACY_HASH_PREFIX}${hash}`;
        return "OK";
      },
    } as unknown as NarrowRedisLike;
    const name = await getSensIndexName(fake, "tgt-J6");
    expect(name).toBe(BASE_INDEX_NAME);
  });

  it("helper-returns-versioned-for-plain: getSensIndexName returns idx:sens:v{hash7} when hash key is plain hex", async () => {
    clearSensIndexNameCache();
    const hash = "abcdef1234567890";
    const fake = {
      async call(command: string, ..._args: unknown[]) {
        if (String(command).toUpperCase() === "GET") return hash;
        return "OK";
      },
    } as unknown as NarrowRedisLike;
    const name = await getSensIndexName(fake, "tgt-J7");
    expect(name).toBe(versionedIndexName(hash));
    expect(name).toBe("idx:sens:vabcdef1");
  });
});


// Wave 6.18l — fake cluster with per-index FT.INFO control. Drives the
// stranded-recovery decision tree:
//   - `versionedDocs` maps versioned index name → num_docs reply (number)
//     OR the sentinel "missing" → throws "Unknown Index name"
//     OR the sentinel "timeout" → throws "Command timed out"
//   - `legacyDocs` same shape for the legacy `idx:sens` probe.
// Hash key SET/GET/DEL is tracked on a single mutable cell so a recovery DEL
// followed by the 6.18j adopt-legacy SET round-trips correctly.
type InfoReply = number | "missing" | "timeout";
interface StrandedClusterOpts {
  oldHash: string | null;
  versionedDocs: InfoReply;
  legacyDocs: InfoReply;
}
function ftInfoReply(indexName: string, kind: InfoReply): unknown {
  if (kind === "missing") throw new Error("Unknown Index name");
  if (kind === "timeout") throw new Error("Command timed out");
  return ["index_name", indexName, "num_docs", String(kind)];
}
function fakeClusterForStranded(
  nodeIds: string[],
  recorded: RecordedCall[],
  opts: StrandedClusterOpts,
): RedisLike {
  const hashCell = { value: opts.oldHash };
  const nodes = nodeIds.map((id) => ({
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: id, command: cmd, args });
      if (cmd === "FT.INFO") {
        const target = String(args[0]);
        if (target === BASE_INDEX_NAME) return ftInfoReply(target, opts.legacyDocs);
        return ftInfoReply(target, opts.versionedDocs);
      }
      return "OK";
    },
  }));
  return {
    nodes: (_role: string) => nodes as unknown as RedisLike[],
    async call(command: string, ...args: unknown[]) {
      const cmd = String(command).toUpperCase();
      recorded.push({ node: "cluster", command: cmd, args });
      if (cmd === "GET") return hashCell.value;
      if (cmd === "SET") { hashCell.value = String(args[1]); return "OK"; }
      if (cmd === "DEL") { hashCell.value = null; return 1; }
      if (cmd === "FT.INFO") {
        const target = String(args[0]);
        if (target === BASE_INDEX_NAME) return ftInfoReply(target, opts.legacyDocs);
        return ftInfoReply(target, opts.versionedDocs);
      }
      if (cmd === "FT.SUGLEN") return 1;
      if (cmd === "FT.AGGREGATE") return [0];
      return "OK";
    },
  } as unknown as RedisLike;
}

describe("bootstrap — Wave 6.18l self-healing stranded versioned index", () => {
  it("recovers on stranded state: hash → empty versioned + populated legacy → DEL + adopt-legacy", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const strandedHash = newHash;          // same schema, just stranded against an empty versioned name
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForStranded(["m1", "m2"], recorded, {
      oldHash: strandedHash,
      versionedDocs: 0,
      legacyDocs: 100_000_000,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-L1" });

    const recovery = logs.find((l) => l.action === "bootstrap-recover-stranded");
    expect(recovery).toMatchObject({
      service: "api",
      bootstrap: "idx:sens",
      action: "bootstrap-recover-stranded",
      target_label: "tgt-L1",
      stranded_versioned_index: versionedIndexName(strandedHash),
      stranded_versioned_docs: 0,
      legacy_index: BASE_INDEX_NAME,
      legacy_docs: 100_000_000,
    });
    // Hash key was DELed before adoption.
    const dels = recorded.filter((r) => r.command === "DEL" && r.args[0] === schemaHashKey("tgt-L1"));
    expect(dels).toHaveLength(1);
    // 6.18j adopt-legacy ran on the same boot: SET legacy:{newHash}, no FT.CREATE/FT.DROPINDEX.
    expect(recorded.some((r) => r.command === "FT.CREATE")).toBe(false);
    expect(recorded.some((r) => r.command === "FT.DROPINDEX")).toBe(false);
    const sets = recorded.filter((r) => r.command === "SET" && r.args[0] === schemaHashKey("tgt-L1"));
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args[1]).toBe(`${LEGACY_HASH_PREFIX}${newHash}`);
    const adopt = logs.find((l) => l.action === "bootstrap-adopt-legacy");
    expect(adopt).toMatchObject({ action: "bootstrap-adopt-legacy", num_docs: 100_000_000 });
    // getSensIndexName resolves to legacy after recovery (cache cleared + legacy prefix written).
    const resolved = await getSensIndexName(c as unknown as NarrowRedisLike, "tgt-L1");
    expect(resolved).toBe(BASE_INDEX_NAME);
  });

  it("does NOT recover when versioned has docs (normal skip path fires instead)", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForStranded(["m1", "m2"], recorded, {
      oldHash: newHash,
      versionedDocs: 5,                  // populated → not stranded
      legacyDocs: 100,                   // legacy also populated (reverse direction is out of scope)
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-L2" });

    expect(logs.some((l) => l.action === "bootstrap-recover-stranded")).toBe(false);
    expect(recorded.some((r) => r.command === "DEL")).toBe(false);
    const skip = logs.find((l) => l.action === "bootstrap-skip");
    expect(skip).toMatchObject({ action: "bootstrap-skip", reason: "schema-unchanged", index: versionedIndexName(newHash) });
    // Adopt-legacy must NOT fire — oldHash was non-null going into 6.18j.
    expect(logs.some((l) => l.action === "bootstrap-adopt-legacy")).toBe(false);
  });

  it("does NOT recover when legacy is empty (versioned empty too → normal create path)", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const staleHash = "deadbeefdeadbeef";
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForStranded(["m1", "m2"], recorded, {
      oldHash: staleHash,
      versionedDocs: 0,
      legacyDocs: 0,                     // empty → no recovery
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-L3" });

    expect(logs.some((l) => l.action === "bootstrap-recover-stranded")).toBe(false);
    expect(recorded.some((r) => r.command === "DEL")).toBe(false);
    expect(logs.some((l) => l.action === "bootstrap-adopt-legacy")).toBe(false);
    // Falls through to versioned-create.
    const creates = recorded.filter((r) => r.command === "FT.CREATE");
    expect(creates.length).toBeGreaterThan(0);
  });

  it("does NOT recover when legacy is missing (normal create path)", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const staleHash = "deadbeefdeadbeef";
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForStranded(["m1", "m2"], recorded, {
      oldHash: staleHash,
      versionedDocs: 0,
      legacyDocs: "missing",
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-L4" });

    expect(logs.some((l) => l.action === "bootstrap-recover-stranded")).toBe(false);
    expect(recorded.some((r) => r.command === "DEL")).toBe(false);
    expect(logs.some((l) => l.action === "bootstrap-adopt-legacy")).toBe(false);
  });

  it("FT.INFO timeout on the recovery probe bubbles up (does NOT silently skip)", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const strandedHash = "deadbeefdeadbeef";
    const recorded: RecordedCall[] = [];
    const c = fakeClusterForStranded(["m1", "m2"], recorded, {
      oldHash: strandedHash,
      versionedDocs: "timeout",          // FT.INFO on versioned hangs / errors
      legacyDocs: 0,
    });
    const logs: Record<string, unknown>[] = [];
    await expect(
      bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-L5" }),
    ).rejects.toThrow(/timed out/i);
    expect(logs.some((l) => l.action === "bootstrap-recover-stranded")).toBe(false);
    // No DEL, no SET, no fall-through to create — the error short-circuits.
    expect(recorded.some((r) => r.command === "DEL")).toBe(false);
    expect(recorded.some((r) => r.command === "FT.CREATE")).toBe(false);
  });

  it("idempotent on second boot: post-recovery state (no hash key + populated legacy) takes the normal 6.18j adopt-legacy path", async () => {
    clearSensIndexNameCache();
    const schema = loadSchema(SCHEMA_PATH);
    const newHash = computeSchemaHash(schema);
    const recorded: RecordedCall[] = [];
    // Simulates the state IMMEDIATELY AFTER a 6.18l recovery completed and the
    // process restarted: the recovery's adopt-legacy SET wrote `legacy:{hash}`,
    // so on this boot the oldHash starts with the LEGACY_HASH_PREFIX and the
    // 6.18j legacy-unchanged skip should fire. No recovery, no adoption, no
    // index rebuild — exactly the steady-state restart shape.
    const c = fakeClusterForStranded(["m1", "m2"], recorded, {
      oldHash: `${LEGACY_HASH_PREFIX}${newHash}`,
      versionedDocs: 0,
      legacyDocs: 100,
    });
    const logs: Record<string, unknown>[] = [];
    await bootstrapFrtb(c, schema, (e) => logs.push(e), { target_label: "tgt-L6" });

    expect(logs.some((l) => l.action === "bootstrap-recover-stranded")).toBe(false);
    expect(logs.some((l) => l.action === "bootstrap-adopt-legacy")).toBe(false);
    expect(recorded.some((r) => r.command === "DEL")).toBe(false);
    expect(recorded.some((r) => r.command === "FT.CREATE")).toBe(false);
    expect(recorded.some((r) => r.command === "FT.DROPINDEX")).toBe(false);
    const skip = logs.find((l) => l.action === "bootstrap-skip");
    expect(skip).toMatchObject({ reason: "legacy-schema-unchanged", index: BASE_INDEX_NAME });
  });
});

