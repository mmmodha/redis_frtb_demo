// Wave 4.6 — RED tests for the per-shard observability endpoint that powers
// the "200 concurrent analysts" demo moment in Wave 4.2.
//
// Contract (spec §"## Wave 4 — Scale, polish, demo-ready (LOCKED)"):
//   GET /observability/shards         → [{ shardId, role, opsPerSec, slotCount,
//                                          usedMemoryBytes, netInBytes,
//                                          netOutBytes }, ...]
//   GET /observability/shards/stream  → SSE, same payload every ~1s
//
// Data sources: CLUSTER NODES (topology + role + slots) and INFO sections
// (memory + stats counters).

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

const CLUSTER_NODES_THREE_PRIMARIES = [
  "a1a1a1a1a1a1a1a1 10.0.0.11:6379@16379 myself,master - 0 0 1 connected 0-5460",
  "b2b2b2b2b2b2b2b2 10.0.0.12:6379@16379 master - 0 1700000000000 2 connected 5461-10922",
  "c3c3c3c3c3c3c3c3 10.0.0.13:6379@16379 master - 0 1700000000000 3 connected 10923-16383",
  "d4d4d4d4d4d4d4d4 10.0.0.21:6379@16379 slave a1a1a1a1a1a1a1a1 0 1700000000000 1 connected",
].join("\n");

const INFO_TEXT = [
  "# Memory",
  "used_memory:524288000",
  "used_memory_human:500.00M",
  "",
  "# Stats",
  "total_net_input_bytes:987654321",
  "total_net_output_bytes:123456789",
  "instantaneous_ops_per_sec:4242",
].join("\r\n");

describe("GET /observability/shards", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns one record per primary parsed from CLUSTER NODES (slaves excluded)", async () => {
    const fr = fakeRedis();
    fr.setResponse("CLUSTER", CLUSTER_NODES_THREE_PRIMARIES);
    fr.setInfo(INFO_TEXT);
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/observability/shards" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
    expect(body.map((r: { shardId: string }) => r.shardId).sort()).toEqual([
      "a1a1a1a1",
      "b2b2b2b2",
      "c3c3c3c3",
    ]);
    for (const r of body) expect(r.role).toBe("master");

    const clusterCall = fr.calls.find((c) => c.command === "CLUSTER");
    expect(clusterCall).toBeDefined();
    expect(clusterCall!.args[0]).toBe("NODES");
  });

  it("exposes slotCount, usedMemoryBytes, netInBytes, netOutBytes, opsPerSec from CLUSTER NODES + INFO", async () => {
    const fr = fakeRedis();
    fr.setResponse("CLUSTER", CLUSTER_NODES_THREE_PRIMARIES);
    fr.setInfo(INFO_TEXT);
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/observability/shards" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const shardA = body.find((r: { shardId: string }) => r.shardId === "a1a1a1a1");
    expect(shardA).toBeDefined();
    expect(shardA.slotCount).toBe(5461); // 0..5460 inclusive
    expect(shardA.usedMemoryBytes).toBe(524288000);
    expect(shardA.netInBytes).toBe(987654321);
    expect(shardA.netOutBytes).toBe(123456789);
    expect(shardA.opsPerSec).toBe(4242);

    const shardC = body.find((r: { shardId: string }) => r.shardId === "c3c3c3c3");
    expect(shardC.slotCount).toBe(5461); // 10923..16383
  });

  it("returns a single primary record on a non-clustered redis (CLUSTER NODES → 1 myself,master line)", async () => {
    const fr = fakeRedis();
    fr.setResponse(
      "CLUSTER",
      "abcd1234abcd1234 127.0.0.1:6379@16379 myself,master - 0 0 0 connected 0-16383",
    );
    fr.setInfo(INFO_TEXT);
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/observability/shards" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].shardId).toBe("abcd1234");
    expect(body[0].slotCount).toBe(16384);
  });
});

// Wave 5.16i — standalone / managed Redis where CLUSTER is blocked.
// INFO blobs used here include `cluster_enabled` + memory/stats fields so the
// fake-redis stub (which returns the same INFO for every section) satisfies
// both the topology probe and the synthetic-shard build.
const INFO_STANDALONE = [
  "# Cluster",
  "cluster_enabled:0",
  "",
  "# Memory",
  "used_memory:67108864",
  "used_memory_human:64.00M",
  "",
  "# Stats",
  "total_net_input_bytes:111222333",
  "total_net_output_bytes:444555666",
  "instantaneous_ops_per_sec:77",
].join("\r\n");

const INFO_CLUSTER_ENABLED_BUT_BLOCKED = [
  "# Cluster",
  "cluster_enabled:1",
  "",
  "# Memory",
  "used_memory:33554432",
  "",
  "# Stats",
  "total_net_input_bytes:1000",
  "total_net_output_bytes:2000",
  "instantaneous_ops_per_sec:9",
].join("\r\n");

describe("GET /observability/shards — standalone / CLUSTER-blocked fallback (Wave 5.16i)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns a single synthetic standalone shard when INFO cluster reports cluster_enabled:0", async () => {
    const fr = fakeRedis();
    fr.setInfo(INFO_STANDALONE);
    // No CLUSTER response stubbed — the route must NOT call CLUSTER on a
    // confirmed-standalone target.
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/observability/shards" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].shardId).toBe("standalone");
    expect(body[0].role).toBe("master");
    expect(body[0].slotCount).toBe(0);
    expect(body[0].usedMemoryBytes).toBe(67108864);
    expect(body[0].netInBytes).toBe(111222333);
    expect(body[0].netOutBytes).toBe(444555666);
    expect(body[0].opsPerSec).toBe(77);

    const clusterCall = fr.calls.find((c) => c.command === "CLUSTER");
    expect(clusterCall).toBeUndefined();
  });

  it("falls back to a synthetic standalone shard when CLUSTER NODES throws `ERR command is not allowed` (managed Redis tiers)", async () => {
    const fr = fakeRedis();
    fr.setInfo(INFO_CLUSTER_ENABLED_BUT_BLOCKED);
    fr.setResponse("CLUSTER", () => {
      throw new Error("ERR command is not allowed");
    });
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/observability/shards" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].shardId).toBe("standalone");
    expect(body[0].role).toBe("master");
    expect(body[0].slotCount).toBe(0);
    expect(body[0].usedMemoryBytes).toBe(33554432);
    expect(body[0].netInBytes).toBe(1000);
    expect(body[0].netOutBytes).toBe(2000);
    expect(body[0].opsPerSec).toBe(9);

    // CLUSTER NODES was attempted (the topology probe said cluster_enabled:1)
    // and then the fallback kicked in on the "not allowed" error.
    const clusterCall = fr.calls.find((c) => c.command === "CLUSTER");
    expect(clusterCall).toBeDefined();
    expect(clusterCall!.args[0]).toBe("NODES");
  });
});

describe("GET /observability/shards/stream (SSE)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("emits synthetic single-shard frames on a standalone target (no 500)", async () => {
    const fr = fakeRedis();
    fr.setInfo(INFO_STANDALONE);
    app = await createServer({ redis: fr, sseIntervalMs: 20 });

    const res = await app.inject({
      method: "GET",
      url: "/observability/shards/stream",
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^text\/event-stream/);

    let buf = "";
    const stream = res.stream() as unknown as NodeJS.ReadableStream;
    const got = await new Promise<string>((resolveDone) => {
      const onData = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        if (buf.split("\n\n").length >= 2) {
          stream.removeListener?.("data", onData);
          resolveDone(buf);
        }
      };
      stream.on("data", onData);
      setTimeout(() => {
        stream.removeListener?.("data", onData);
        resolveDone(buf);
      }, 200);
    });

    const frames = got.split("\n\n").filter((s) => s.startsWith("data:"));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(frames[0].replace(/^data: ?/, "").trim());
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0].shardId).toBe("standalone");
    expect(payload[0].role).toBe("master");
    expect(payload[0].slotCount).toBe(0);
  });

  it("streams data: events containing the same shard payload (text/event-stream)", async () => {
    const fr = fakeRedis();
    fr.setResponse("CLUSTER", CLUSTER_NODES_THREE_PRIMARIES);
    fr.setInfo(INFO_TEXT);
    app = await createServer({ redis: fr, sseIntervalMs: 20 });

    const res = await app.inject({
      method: "GET",
      url: "/observability/shards/stream",
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^text\/event-stream/);

    // Collect ~80ms of data — should see at least 2 SSE frames at 20ms interval.
    let buf = "";
    const stream = res.stream();
    const reader = stream as unknown as NodeJS.ReadableStream;
    const got = await new Promise<string>((resolveDone) => {
      const onData = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        if (buf.split("\n\n").length >= 3) {
          reader.removeListener?.("data", onData);
          resolveDone(buf);
        }
      };
      reader.on("data", onData);
      setTimeout(() => {
        reader.removeListener?.("data", onData);
        resolveDone(buf);
      }, 200);
    });

    const frames = got.split("\n\n").filter((s) => s.startsWith("data:"));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(frames[0].replace(/^data: ?/, "").trim());
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]).toHaveProperty("shardId");
    expect(payload[0]).toHaveProperty("opsPerSec");
  });
});
