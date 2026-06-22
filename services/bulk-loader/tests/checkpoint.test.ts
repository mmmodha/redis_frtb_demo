// Wave 7.0.5.A — checkpoint persistence + bootstrap-load tests.
//
// Drives the periodic HSET, the HGETALL bootstrap reply parser, and the
// graceful-degradation paths (HSET failure should warn and continue;
// HGETALL failure should not poison the load).

import { describe, it, expect } from "vitest";
import {
  createCheckpointer,
  parseHgetallReply,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  type CheckpointClient,
} from "../src/checkpoint.ts";

class FakeCheckpointClient implements CheckpointClient {
  hsets: Array<{ key: string; fields: Record<string, string> }> = [];
  hgetallReplies = new Map<string, unknown>();
  failHsetFor = new Set<string>();
  failHgetallFor = new Set<string>();

  async call(command: string, ...args: unknown[]): Promise<unknown> {
    const cmd = command.toUpperCase();
    const key = String(args[0] ?? "");
    if (cmd === "HSET") {
      if (this.failHsetFor.has(key)) throw new Error(`fake: HSET failed for ${key}`);
      const fields: Record<string, string> = {};
      for (let i = 1; i + 1 < args.length; i += 2) {
        fields[String(args[i])] = String(args[i + 1]);
      }
      this.hsets.push({ key, fields });
      return Object.keys(fields).length;
    }
    if (cmd === "HGETALL") {
      if (this.failHgetallFor.has(key)) throw new Error(`fake: HGETALL failed for ${key}`);
      return this.hgetallReplies.get(key) ?? [];
    }
    return null;
  }
}

describe("DEFAULT_CHECKPOINT_INTERVAL_MS", () => {
  it("matches the spec default (30s)", () => {
    expect(DEFAULT_CHECKPOINT_INTERVAL_MS).toBe(30_000);
  });
});

describe("parseHgetallReply", () => {
  it("parses ioredis flat-array reply", () => {
    const r = parseHgetallReply([
      "rows_written", "100",
      "last_ulid", "01HZA00000000000000000",
      "last_updated", "1700000000000",
    ]);
    expect(r).toEqual({
      rows_written: 100,
      last_ulid: "01HZA00000000000000000",
      last_updated: 1700000000000,
    });
  });

  it("parses object-shaped reply", () => {
    const r = parseHgetallReply({
      rows_written: "5",
      last_ulid: "01HZB00000000000000000",
      last_updated: "1700",
    });
    expect(r?.rows_written).toBe(5);
    expect(r?.last_ulid).toBe("01HZB00000000000000000");
  });

  it("coerces empty-string last_ulid to null", () => {
    const r = parseHgetallReply(["rows_written", "0", "last_ulid", "", "last_updated", "0"]);
    expect(r?.last_ulid).toBeNull();
    expect(r?.rows_written).toBe(0);
  });

  it("returns null for empty array, empty object, null, or non-object", () => {
    expect(parseHgetallReply([])).toBeNull();
    expect(parseHgetallReply({})).toBeNull();
    expect(parseHgetallReply(null)).toBeNull();
    expect(parseHgetallReply("nope")).toBeNull();
  });
});

describe("createCheckpointer — flushOnce", () => {
  it("HSETs one bulk:checkpoint:<id> per worker with the expected fields", async () => {
    const client = new FakeCheckpointClient();
    let nowVal = 1700000000000;
    const cp = createCheckpointer({
      client,
      source: { workers: () => [
        { id: 0, flushed: 10, lastUlid: "01HZA00000000000000000" },
        { id: 1, flushed: 7, lastUlid: null },
      ]},
      intervalMs: 60_000,
      now: () => nowVal,
    });
    await cp.flushOnce();
    expect(client.hsets).toHaveLength(2);
    expect(client.hsets[0]!.key).toBe("bulk:checkpoint:0");
    expect(client.hsets[0]!.key).not.toMatch(/[{}]/);
    expect(client.hsets[0]!.fields).toEqual({
      rows_written: "10",
      last_ulid: "01HZA00000000000000000",
      last_updated: String(nowVal),
    });
    expect(client.hsets[1]!.fields.last_ulid).toBe("");
    await cp.stop();
  });

  it("does not throw when an individual HSET fails — keeps writing the rest", async () => {
    const client = new FakeCheckpointClient();
    client.failHsetFor.add("bulk:checkpoint:0");
    const warns: object[] = [];
    const cp = createCheckpointer({
      client,
      source: { workers: () => [
        { id: 0, flushed: 1, lastUlid: "u0" },
        { id: 1, flushed: 2, lastUlid: "u1" },
      ]},
      intervalMs: 60_000,
      logger: { warn: (obj) => warns.push(obj) },
    });
    await expect(cp.flushOnce()).resolves.toBeUndefined();
    expect(client.hsets.map((h) => h.key)).toEqual(["bulk:checkpoint:1"]);
    expect(warns.length).toBe(1);
    await cp.stop();
  });

  it("validates intervalMs is a positive number", () => {
    const client = new FakeCheckpointClient();
    const src = { workers: () => [] };
    expect(() => createCheckpointer({ client, source: src, intervalMs: 0 })).toThrow(/positive/);
    expect(() => createCheckpointer({ client, source: src, intervalMs: -1 })).toThrow(/positive/);
    expect(() => createCheckpointer({ client, source: src, intervalMs: NaN })).toThrow(/positive/);
  });
});

describe("createCheckpointer — loadAll", () => {
  it("reads bulk:checkpoint:0..N-1 and parses each reply", async () => {
    const client = new FakeCheckpointClient();
    client.hgetallReplies.set("bulk:checkpoint:0", [
      "rows_written", "100", "last_ulid", "01HZA00000000000000000", "last_updated", "1700",
    ]);
    client.hgetallReplies.set("bulk:checkpoint:2", {
      rows_written: "5", last_ulid: "01HZC00000000000000000", last_updated: "1701",
    });
    const cp = createCheckpointer({
      client, source: { workers: () => [] }, intervalMs: 60_000,
    });
    const out = await cp.loadAll(3);
    expect(out.size).toBe(2);
    expect(out.get(0)?.rows_written).toBe(100);
    expect(out.get(2)?.last_ulid).toBe("01HZC00000000000000000");
    expect(out.has(1)).toBe(false);
    await cp.stop();
  });

  it("tolerates HGETALL failures (warn + continue)", async () => {
    const client = new FakeCheckpointClient();
    client.failHgetallFor.add("bulk:checkpoint:0");
    client.hgetallReplies.set("bulk:checkpoint:1", [
      "rows_written", "9", "last_ulid", "u9", "last_updated", "1",
    ]);
    const warns: object[] = [];
    const cp = createCheckpointer({
      client, source: { workers: () => [] }, intervalMs: 60_000,
      logger: { warn: (obj) => warns.push(obj) },
    });
    const out = await cp.loadAll(2);
    expect(out.size).toBe(1);
    expect(out.get(1)?.last_ulid).toBe("u9");
    expect(warns.length).toBe(1);
    await cp.stop();
  });

  it("returns empty map for count < 1 or non-integer", async () => {
    const client = new FakeCheckpointClient();
    const cp = createCheckpointer({
      client, source: { workers: () => [] }, intervalMs: 60_000,
    });
    expect((await cp.loadAll(0)).size).toBe(0);
    expect((await cp.loadAll(-5)).size).toBe(0);
    expect((await cp.loadAll(1.5)).size).toBe(0);
    await cp.stop();
  });
});

describe("createCheckpointer — stop() final flush", () => {
  it("persists one last round before fully stopping", async () => {
    const client = new FakeCheckpointClient();
    const cp = createCheckpointer({
      client,
      source: { workers: () => [{ id: 0, flushed: 99, lastUlid: "uFinal" }] },
      intervalMs: 60_000,
    });
    cp.start();
    await cp.stop();
    expect(client.hsets.length).toBeGreaterThanOrEqual(1);
    expect(client.hsets[client.hsets.length - 1]!.fields.last_ulid).toBe("uFinal");
  });
});
