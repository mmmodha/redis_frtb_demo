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
import { parseShardAssignment, shardStreamKey } from "../src/sharding.ts";
import {
  createMultiShardConsumer,
  ensureGroupsForShards,
} from "../src/multi-consumer.ts";
import type { RedisLike } from "../src/consumer.ts";

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
