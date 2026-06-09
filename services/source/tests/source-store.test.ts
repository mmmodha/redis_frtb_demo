// Failing tests for the Redis-backed source metadata store.
//
// Storage shape (per supervisor task focus): metadata at key `source:<id>`
// as a JSON blob (string). File contents are NOT stored in Redis — only the
// path/metadata. The store is exercised here with an in-memory fake of the
// narrow Redis surface the store actually uses.

import { describe, it, expect, beforeEach } from "vitest";
import { createSourceStore, type Source } from "../src/store.ts";
import { makeFakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";

let redis: FakeRedis;
let store: ReturnType<typeof createSourceStore>;

beforeEach(() => {
  redis = makeFakeRedis();
  store = createSourceStore({ redis });
});

describe("createSourceStore", () => {
  it("creates a source with a fresh ULID and writes source:<id> to redis", async () => {
    const s = await store.create({
      name: "girr-1m.csv",
      format: "csv",
      origin: "upload",
      path: "/data/uploads/abc.csv",
      size_bytes: 1024,
    });
    expect(s.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(s.status).toBe("uploaded");
    expect(s.name).toBe("girr-1m.csv");
    expect(s.format).toBe("csv");
    expect(redis.data.get(`source:${s.id}`)).toBeDefined();
  });

  it("get() returns the persisted record", async () => {
    const s = await store.create({ name: "x.csv", format: "csv", origin: "upload", path: "/tmp/x" });
    const got = await store.get(s.id);
    expect(got).toEqual(s);
  });

  it("list() returns all sources via the source:index SET (no SCAN)", async () => {
    await store.create({ name: "a", format: "csv", origin: "upload", path: "/tmp/a" });
    await store.create({ name: "b", format: "jsonl", origin: "upload", path: "/tmp/b" });
    redis.calls.length = 0;
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(redis.calls).not.toContain("SCAN");
    expect(redis.calls).toContain("SMEMBERS");
  });

  it("update() merges fields and bumps updated_at", async () => {
    const s = await store.create({ name: "x", format: "csv", origin: "upload", path: "/tmp/x" });
    const before = s.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    const u = await store.update(s.id, { status: "inferred", row_count_sample: 100 });
    expect(u?.status).toBe("inferred");
    expect(u?.row_count_sample).toBe(100);
    expect(u?.updated_at).not.toBe(before);
  });

  it("update() returns null when the id is unknown", async () => {
    expect(await store.update("does-not-exist", { status: "mapped" })).toBeNull();
  });

  it("delete() removes the source from redis and from the source:index SET", async () => {
    const s = await store.create({ name: "x", format: "csv", origin: "upload", path: "/tmp/x" });
    expect(redis.sets.get("source:index")?.has(s.id)).toBe(true);
    expect(await store.delete(s.id)).toBe(true);
    expect(await store.get(s.id)).toBeNull();
    expect(redis.data.has(`source:${s.id}`)).toBe(false);
    expect(redis.sets.get("source:index")?.has(s.id) ?? false).toBe(false);
  });

  it("list() lazily seeds the index from SCAN when source:<id> keys exist but the index is empty", async () => {
    const orphanId = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    const payload: Source = {
      id: orphanId,
      name: "pre-existing.csv",
      format: "csv",
      origin: "upload",
      path: "/data/uploads/pre-existing.csv",
      status: "uploaded",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    redis.data.set(`source:${orphanId}`, JSON.stringify(payload));

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(orphanId);
    expect(redis.sets.get("source:index")?.has(orphanId)).toBe(true);

    redis.calls.length = 0;
    const again = await store.list();
    expect(again).toHaveLength(1);
    expect(redis.calls).not.toContain("SCAN");
  });

  it("list() prunes orphaned index entries whose underlying source:<id> key is missing", async () => {
    const s = await store.create({ name: "real", format: "csv", origin: "upload", path: "/tmp/real" });
    const ghostId = "01HZZZZZZZZZZZZZZZZZZZZZZG";
    redis.sets.get("source:index")?.add(ghostId);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(s.id);
    expect(redis.sets.get("source:index")?.has(ghostId)).toBe(false);
    expect(redis.sets.get("source:index")?.has(s.id)).toBe(true);
  });

  it("setMapping() stores the mapping on the source and moves status to 'mapped'", async () => {
    const s = await store.create({ name: "x", format: "csv", origin: "upload", path: "/tmp/x" });
    const mapping = { fields: { risk_class: { from: "risk_class" } } } as Source["mapping"];
    const u = await store.setMapping(s.id, mapping!);
    expect(u?.mapping).toEqual(mapping);
    expect(u?.status).toBe("mapped");
  });

  it("setColumns() stores the inferred column list and moves status to 'inferred'", async () => {
    const s = await store.create({ name: "x", format: "csv", origin: "upload", path: "/tmp/x" });
    const cols = [{ name: "risk_class", detected_type: "TAG" as const, sample_values: ["GIRR"] }];
    const u = await store.setColumns(s.id, cols, 100);
    expect(u?.columns).toEqual(cols);
    expect(u?.row_count_sample).toBe(100);
    expect(u?.status).toBe("inferred");
  });
});
