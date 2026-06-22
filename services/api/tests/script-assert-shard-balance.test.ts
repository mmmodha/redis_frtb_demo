// Wave 7.0.6.5 — Unit tests for scripts/assert-shard-balance.mjs.
//
// Exercises evaluateBalance() against rladmin info shards fixtures that
// extend the Wave 7.0.4.A parser fixtures with the optional KEYS column.
// Covers pass + fail cases for both metrics, with and without --before.

import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs sibling without typings; runtime shape is documented.
import { evaluateBalance, parseArgs } from "../../../scripts/assert-shard-balance.mjs";
import { parseRladminShards } from "../src/lib/rladmin-parser.mjs";

const SHARDS_BEFORE_BALANCED = [
  "SHARD:ID  NODE:ID  ROLE     NAME  SLOTS         USED_MEMORY  KEYS",
  "redis:1   node:1   master   db:1  0-8191        100MB        100000",
  "redis:2   node:2   master   db:1  8192-16383    100MB        100000",
].join("\n");

const SHARDS_AFTER_BALANCED = [
  "SHARD:ID  NODE:ID  ROLE     NAME  SLOTS         USED_MEMORY  KEYS",
  "redis:1   node:1   master   db:1  0-8191        150MB        150000",
  "redis:2   node:2   master   db:1  8192-16383    151MB        149000",
].join("\n");

const SHARDS_AFTER_SKEWED_KEYS = [
  "SHARD:ID  NODE:ID  ROLE     NAME  SLOTS         USED_MEMORY  KEYS",
  "redis:1   node:1   master   db:1  0-8191        100MB        100000",
  "redis:2   node:2   master   db:1  8192-16383    100MB        200000",
].join("\n");

const SHARDS_AFTER_SKEWED_MEMORY = [
  "SHARD:ID  NODE:ID  ROLE     NAME  SLOTS         USED_MEMORY  KEYS",
  "redis:1   node:1   master   db:1  0-8191         50MB        100000",
  "redis:2   node:2   master   db:1  8192-16383    200MB        100000",
].join("\n");

const SHARDS_NO_KEYS_COLUMN = [
  "SHARD:ID  NODE:ID  ROLE     NAME  SLOTS         USED_MEMORY",
  "redis:1   node:1   master   db:1  0-8191        100MB",
  "redis:2   node:2   master   db:1  8192-16383    100MB",
].join("\n");

describe("assert-shard-balance · parseArgs", () => {
  it("applies documented defaults", () => {
    const a = parseArgs(["--after", "/tmp/a.txt"]);
    expect(a.tolerance).toBe(0.05);
    expect(a.check).toBe("both");
    expect(a.after).toBe("/tmp/a.txt");
    expect(a.before).toBeNull();
  });

  it("parses --before/--tolerance/--check overrides", () => {
    const a = parseArgs([
      "--before", "/tmp/b.txt", "--after", "/tmp/a.txt",
      "--tolerance", "0.1", "--check", "keys",
    ]);
    expect(a.before).toBe("/tmp/b.txt");
    expect(a.tolerance).toBe(0.1);
    expect(a.check).toBe("keys");
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
  });
});

describe("assert-shard-balance · evaluateBalance (absolute)", () => {
  it("passes when both metrics are within tolerance", () => {
    const afterRows = parseRladminShards(SHARDS_AFTER_BALANCED);
    const v = evaluateBalance({ afterRows, beforeRows: null, tolerance: 0.05, check: "both" });
    expect(v.ok).toBe(true);
    expect(v.mode).toBe("absolute");
    expect(v.metrics.keys.perShard).toHaveLength(2);
    expect(v.metrics.memory.perShard).toHaveLength(2);
  });

  it("fails when key counts are skewed beyond tolerance", () => {
    const afterRows = parseRladminShards(SHARDS_AFTER_SKEWED_KEYS);
    const v = evaluateBalance({ afterRows, beforeRows: null, tolerance: 0.05, check: "keys" });
    expect(v.ok).toBe(false);
    expect(v.metrics.keys.ok).toBe(false);
    const outOf = v.metrics.keys.perShard.filter((s: { within: boolean }) => !s.within);
    expect(outOf.length).toBeGreaterThan(0);
  });

  it("fails when memory is skewed beyond tolerance", () => {
    const afterRows = parseRladminShards(SHARDS_AFTER_SKEWED_MEMORY);
    const v = evaluateBalance({ afterRows, beforeRows: null, tolerance: 0.10, check: "memory" });
    expect(v.ok).toBe(false);
    expect(v.metrics.memory.ok).toBe(false);
  });

  it("reports a clear reason when --check keys runs on a no-KEYS snapshot", () => {
    const afterRows = parseRladminShards(SHARDS_NO_KEYS_COLUMN);
    const v = evaluateBalance({ afterRows, beforeRows: null, tolerance: 0.05, check: "keys" });
    expect(v.ok).toBe(false);
    expect(String(v.metrics.keys.reason)).toMatch(/KEYS\/OBJECTS column/);
  });

  it("can still --check memory on a no-KEYS snapshot", () => {
    const afterRows = parseRladminShards(SHARDS_NO_KEYS_COLUMN);
    const v = evaluateBalance({ afterRows, beforeRows: null, tolerance: 0.05, check: "memory" });
    expect(v.ok).toBe(true);
  });
});

describe("assert-shard-balance · evaluateBalance (delta with --before)", () => {
  it("passes when per-shard deltas are within tolerance of the mean delta", () => {
    const beforeRows = parseRladminShards(SHARDS_BEFORE_BALANCED);
    const afterRows = parseRladminShards(SHARDS_AFTER_BALANCED);
    const v = evaluateBalance({ afterRows, beforeRows, tolerance: 0.05, check: "keys" });
    expect(v.ok).toBe(true);
    expect(v.mode).toBe("delta");
    // delta_redis:1 = 50000, delta_redis:2 = 49000, mean = 49500 → ±~1% each.
    for (const s of v.metrics.keys.perShard) expect(Math.abs(s.deviation_pct)).toBeLessThanOrEqual(0.05);
  });

  it("fails when one shard's delta is far from the mean delta", () => {
    const beforeRows = parseRladminShards(SHARDS_BEFORE_BALANCED);
    const afterRows = parseRladminShards(SHARDS_AFTER_SKEWED_KEYS);
    const v = evaluateBalance({ afterRows, beforeRows, tolerance: 0.05, check: "keys" });
    expect(v.ok).toBe(false);
  });
});
