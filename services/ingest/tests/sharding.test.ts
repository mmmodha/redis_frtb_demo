// Wave 5.92B — unit suite for the multi-shard consumer driver.
//
// Three layers exercised here:
//   1. parseShardAssignment + shardStreamKey pure helpers (env-string parsing
//      and per-shard stream-key construction).
//   2. createMultiShardConsumer end-to-end against a stub Redis that records
//      every XREADGROUP stream argument, verifying the driver opens exactly
//      one XREADGROUP loop per assigned shard against the expected key.
//   3. An active-target swap scenario (drain all per-shard runners on the
//      previous client, respawn against the new client) using two stub
//      clients — extends the existing watcher-callback contract to multi-shard.

import { describe, it, expect } from "vitest";
import http from "node:http";
import { parseShardAssignment, shardStreamKey } from "../src/sharding.ts";
import {
  createMultiShardConsumer,
  ensureGroupsForShards,
  type MultiConsumer,
} from "../src/multi-consumer.ts";
import type { RedisLike } from "../src/consumer.ts";
import { createShardRuntime } from "../src/shard-runtime.ts";

interface StubClient {
  reads: string[];
  groupCreates: Array<{ stream: string; group: string }>;
  client: RedisLike;
}

function makeStubClient(): StubClient {
  const reads: string[] = [];
  const groupCreates: Array<{ stream: string; group: string }> = [];
  const client = {
    async xreadgroup(...args: unknown[]): Promise<null> {
      // Find the stream key — it's the arg after the "STREAMS" sentinel.
      const idx = args.indexOf("STREAMS");
      const stream = idx >= 0 ? String(args[idx + 1]) : "<unknown>";
      reads.push(stream);
      await new Promise((r) => setTimeout(r, 5));
      return null;
    },
    async xgroup(_verb: string, stream: string, group: string): Promise<string> {
      groupCreates.push({ stream, group });
      return "OK";
    },
    pipeline(): unknown {
      // No entries are returned by xreadgroup above, so processBatch never
      // calls pipeline.exec() — the stub only needs to satisfy the type shape.
      const pl = {
        call(): unknown { return pl; },
        xack(): unknown { return pl; },
        async exec(): Promise<unknown[]> { return []; },
      };
      return pl;
    },
  };
  return { reads, groupCreates, client: client as unknown as RedisLike };
}

describe("parseShardAssignment", () => {
  it("'all' expands to every shard index", () => {
    expect(parseShardAssignment("all", 4)).toEqual([0, 1, 2, 3]);
  });
  it("empty spec defaults to every shard index", () => {
    expect(parseShardAssignment("", 3)).toEqual([0, 1, 2]);
  });
  it("'ALL' is case-insensitive", () => {
    expect(parseShardAssignment("ALL", 2)).toEqual([0, 1]);
  });
  it("explicit comma list keeps input order and dedupes", () => {
    expect(parseShardAssignment("2, 0, 2, 1", 4)).toEqual([2, 0, 1]);
  });
  it("inclusive range a-b expands forward", () => {
    expect(parseShardAssignment("0-3", 4)).toEqual([0, 1, 2, 3]);
  });
  it("inclusive range filters out-of-bounds high end", () => {
    expect(parseShardAssignment("2-9", 4)).toEqual([2, 3]);
  });
  it("explicit list drops non-numeric and out-of-bounds entries", () => {
    expect(parseShardAssignment("0,foo,4,2", 3)).toEqual([0, 2]);
  });
  it("total=0 yields an empty assignment", () => {
    expect(parseShardAssignment("all", 0)).toEqual([]);
  });
});

describe("shardStreamKey", () => {
  it("returns the bare base key when totalShards <= 1 (back-compat)", () => {
    expect(shardStreamKey("sensitivities:in", 0, 1)).toBe("sensitivities:in");
  });
  it("wraps shard index in literal braces so the cluster slot is forced by <n>", () => {
    expect(shardStreamKey("sensitivities:in", 2, 4)).toBe("sensitivities:in:{2}");
  });
});

describe("ensureGroupsForShards", () => {
  it("calls XGROUP CREATE once per shard stream against the shared group name", async () => {
    const stub = makeStubClient();
    await ensureGroupsForShards(stub.client, ["sensitivities:in:{0}", "sensitivities:in:{1}"], "ingest");
    expect(stub.groupCreates).toEqual([
      { stream: "sensitivities:in:{0}", group: "ingest" },
      { stream: "sensitivities:in:{1}", group: "ingest" },
    ]);
  });
});

describe("createMultiShardConsumer", () => {
  it("STREAM_SHARDS=4 SHARD_ASSIGNMENT=all opens 4 XREADGROUP loops against sensitivities:in:{0..3}", async () => {
    const stub = makeStubClient();
    const multi = createMultiShardConsumer(stub.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 4, assignment: [0, 1, 2, 3], batchSize: 10, blockMs: 5,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 60));
    await multi.stop();
    expect(new Set(stub.reads)).toEqual(new Set([
      "sensitivities:in:{0}", "sensitivities:in:{1}",
      "sensitivities:in:{2}", "sensitivities:in:{3}",
    ]));
    expect(multi.handles).toHaveLength(4);
    expect(multi.handles.map((h) => h.consumerName)).toEqual([
      "ingest-host-1-s0", "ingest-host-1-s1", "ingest-host-1-s2", "ingest-host-1-s3",
    ]);
  });

  it("SHARD_ASSIGNMENT=0,2 reads only those two shards", async () => {
    const stub = makeStubClient();
    const multi = createMultiShardConsumer(stub.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 4, assignment: [0, 2], batchSize: 10, blockMs: 5,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 60));
    await multi.stop();
    const distinct = new Set(stub.reads);
    expect(distinct).toEqual(new Set(["sensitivities:in:{0}", "sensitivities:in:{2}"]));
    expect(distinct.size).toBe(2);
  });

  it("STREAM_SHARDS=1 falls back to the bare sensitivities:in key and the unsuffixed consumer name", async () => {
    const stub = makeStubClient();
    const multi = createMultiShardConsumer(stub.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 1, assignment: [0], batchSize: 10, blockMs: 5,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 30));
    await multi.stop();
    expect(new Set(stub.reads)).toEqual(new Set(["sensitivities:in"]));
    expect(multi.handles[0]!.consumerName).toBe("ingest-host-1");
  });
});

// Wave 6.12a — runtime shard-control endpoint. Drives a real http.Server bound
// to a stub Redis client so the POST /ingest/shards handler exercises the
// full rebuild path: drain the previous MultiConsumer, recompute the
// assignment, spawn a fresh runner per shard, return the new snapshot. Also
// covers the 400 (invalid body) and 409 (rebuild already in-flight) branches
// the DoD calls out.

interface RuntimeFixture {
  server: http.Server;
  base: string;
  stub: StubClient;
  stopCalls: number;
  stop(): Promise<void>;
}

async function startRuntimeServer(initialTotalShards: number, initialAssignmentSpec: string): Promise<RuntimeFixture> {
  const stub = makeStubClient();
  let stopCalls = 0;
  const runtime = createShardRuntime({
    baseStream: "sensitivities:in",
    initialTotalShards,
    initialAssignmentSpec,
    spawn: async (totalShards, assignment) => {
      const streams = assignment.map((s) => shardStreamKey("sensitivities:in", s, totalShards));
      await ensureGroupsForShards(stub.client, streams, "ingest");
      const m = createMultiShardConsumer(stub.client, {
        baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
        totalShards, assignment, batchSize: 10, blockMs: 5,
      });
      // Wrap stop() so we can count drain calls without subclassing MultiConsumer.
      const realStop = m.stop.bind(m);
      const wrapped: MultiConsumer = { ...m, async stop() { stopCalls += 1; return realStop(); } };
      wrapped.start();
      return wrapped;
    },
  });
  const server = http.createServer((req, res) => {
    if (runtime.handleRequest(req, res, { consumed: 0, errors: 0, ready: true })) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  // Initial spawn so /ingest/shards has live state, mirroring cli.ts boot.
  await runtime.rebuild();
  return {
    server,
    base: `http://127.0.0.1:${addr.port}`,
    stub,
    get stopCalls(): number { return stopCalls; },
    async stop(): Promise<void> {
      const m = runtime.getMulti();
      if (m) await m.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("POST /ingest/shards rebuilds the multi-consumer", () => {
  it("starts at totalShards=1, then POST totalShards=4 drains the bare-key runner and opens XREADGROUP loops against :{0..3}", async () => {
    const fx = await startRuntimeServer(1, "all");
    try {
      await new Promise((r) => setTimeout(r, 30));
      // Initial single-shard mode reads against the bare key only.
      expect(new Set(fx.stub.reads)).toEqual(new Set(["sensitivities:in"]));
      const stopsBefore = fx.stopCalls;

      const res = await fetch(`${fx.base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 4 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { totalShards: number; assignment: number[]; streams: string[] };
      expect(body.totalShards).toBe(4);
      expect(body.assignment).toEqual([0, 1, 2, 3]);
      expect(body.streams).toEqual([
        "sensitivities:in:{0}", "sensitivities:in:{1}",
        "sensitivities:in:{2}", "sensitivities:in:{3}",
      ]);

      // Drain ran on the previous runner before the new one was spawned.
      expect(fx.stopCalls).toBe(stopsBefore + 1);

      await new Promise((r) => setTimeout(r, 60));
      const distinct = new Set(fx.stub.reads);
      // New per-shard XREADGROUP loops are now open against the wrapped shard keys.
      for (const k of ["sensitivities:in:{0}", "sensitivities:in:{1}", "sensitivities:in:{2}", "sensitivities:in:{3}"]) {
        expect(distinct.has(k)).toBe(true);
      }
    } finally {
      await fx.stop();
    }
  });

  it("GET /ingest/shards returns the current snapshot shape", async () => {
    const fx = await startRuntimeServer(2, "0,1");
    try {
      const res = await fetch(`${fx.base}/ingest/shards`);
      expect(res.status).toBe(200);
      const body = await res.json() as { totalShards: number; assignment: number[]; streams: string[] };
      expect(body).toEqual({
        totalShards: 2,
        assignment: [0, 1],
        streams: ["sensitivities:in:{0}", "sensitivities:in:{1}"],
      });
    } finally {
      await fx.stop();
    }
  });

  it("returns 400 when totalShards is missing / non-integer / < 1", async () => {
    const fx = await startRuntimeServer(1, "all");
    try {
      for (const payload of [{}, { totalShards: "4" }, { totalShards: 0 }, { totalShards: -2 }, { totalShards: 1.5 }]) {
        const res = await fetch(`${fx.base}/ingest/shards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
      }
      const res = await fetch(`${fx.base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  it("returns 409 when a rebuild is already in flight", async () => {
    // Block the second spawn until the first POST has had a chance to start.
    // We achieve this by overriding the spawn to await a Promise we control;
    // a small wrapper around startRuntimeServer would be heavier than what's
    // needed — instead we drive the runtime directly here.
    const stub = makeStubClient();
    let releaseSpawn: (() => void) | null = null;
    let spawnCalls = 0;
    const runtime = createShardRuntime({
      baseStream: "sensitivities:in",
      initialTotalShards: 1,
      initialAssignmentSpec: "all",
      spawn: async (totalShards, assignment) => {
        spawnCalls += 1;
        if (spawnCalls >= 2) {
          await new Promise<void>((r) => { releaseSpawn = r; });
        }
        const streams = assignment.map((s) => shardStreamKey("sensitivities:in", s, totalShards));
        await ensureGroupsForShards(stub.client, streams, "ingest");
        const m = createMultiShardConsumer(stub.client, {
          baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
          totalShards, assignment, batchSize: 10, blockMs: 5,
        });
        m.start();
        return m;
      },
    });
    await runtime.rebuild(); // initial spawn — spawnCalls=1
    const server = http.createServer((req, res) => {
      if (runtime.handleRequest(req, res, { consumed: 0, errors: 0, ready: true })) return;
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const first = fetch(`${base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 4 }),
      });
      // Yield so the first request enters spawn() and blocks on releaseSpawn.
      await new Promise((r) => setTimeout(r, 30));
      const second = await fetch(`${base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 2 }),
      });
      expect(second.status).toBe(409);
      if (releaseSpawn) (releaseSpawn as () => void)();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      const m = runtime.getMulti();
      if (m) await m.stop();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("GET /ingest/status includes consumed/errors/ready alongside the snapshot", async () => {
    const fx = await startRuntimeServer(2, "all");
    try {
      const res = await fetch(`${fx.base}/ingest/status`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        totalShards: 2,
        assignment: [0, 1],
        streams: ["sensitivities:in:{0}", "sensitivities:in:{1}"],
        consumed: 0,
        errors: 0,
        ready: true,
      });
    } finally {
      await fx.stop();
    }
  });
});

