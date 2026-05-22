// Failing tests for the source → Stream ingest pipeline.
//
// Reads a CSV with a confirmed mapping and emits one XADD per row to
// the locked Wave-2 inbound stream `sensitivities:in`. Each XADD's
// fields MUST include `_hash_tag` = `{risk_class}:{bucket}` so the
// downstream ingest service can write the final JSON key
// `sens:{risk_class:bucket}:{ulid}` slot-locally.

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestFile } from "../src/ingest.ts";
import { makeFakeRedis } from "./helpers/fake-redis.ts";
import type { ColumnMapping } from "../src/infer/mapping.ts";

const FIXTURES = resolve(fileURLToPath(import.meta.url), "..", "fixtures");

describe("ingestFile — CSV with direct field mapping", () => {
  it("emits one XADD per row into sensitivities:in", async () => {
    const redis = makeFakeRedis();
    const mapping: ColumnMapping = {
      fields: {
        risk_class: { from: "risk_class" },
        bucket: { from: "bucket" },
        sensitivity_type: { from: "sensitivity_type" },
        tenor: { from: "tenor" },
        risk_value: { from: "risk_value", type: "number" },
        weight: { from: "weight", type: "number" },
        trade_id: { from: "trade_id" },
        book: { from: "book" },
      },
    };
    const stats = await ingestFile({
      redis,
      path: resolve(FIXTURES, "girr-small.csv"),
      format: "csv",
      mapping,
    });
    expect(stats.rows_ingested).toBe(6);
    expect(redis.streams).toHaveLength(6);
    for (const entry of redis.streams) {
      expect(entry.stream).toBe("sensitivities:in");
      expect(entry.fields._hash_tag).toMatch(/^GIRR:[A-Z]{3}-IRS$/);
      expect(entry.fields.risk_class).toBe("GIRR");
    }
    expect(redis.streams[0]!.fields._hash_tag).toBe("GIRR:USD-IRS");
  });
});

describe("ingestFile — tenor-array mapping", () => {
  it("collapses multiple tenor columns into a single JSON array on risk_value", async () => {
    const redis = makeFakeRedis();
    const mapping: ColumnMapping = {
      fields: {
        risk_class: { from: "risk_class" },
        bucket: { from: "bucket" },
        sensitivity_type: { from: "sensitivity_type" },
        risk_value: {
          from: ["tenor_3M", "tenor_6M", "tenor_1Y", "tenor_2Y", "tenor_5Y", "tenor_10Y"],
          type: "array_number",
        },
        book: { from: "book" },
      },
    };
    const stats = await ingestFile({
      redis,
      path: resolve(FIXTURES, "tenor-wide.csv"),
      format: "csv",
      mapping,
    });
    expect(stats.rows_ingested).toBe(3);
    const first = redis.streams[0]!;
    // risk_value is JSON-encoded on the Stream because Stream fields are
    // strings only; the ingest service parses it back into the JSON array
    // when writing the final JSON.SET.
    expect(JSON.parse(first.fields.risk_value!)).toEqual([0.10, 0.20, 0.30, 0.40, 0.50, 0.60]);
    expect(first.fields._hash_tag).toBe("GIRR:USD-IRS");
  });
});

describe("ingestFile — progress callback", () => {
  it("invokes onProgress with cumulative row counts", async () => {
    const redis = makeFakeRedis();
    const events: number[] = [];
    await ingestFile({
      redis,
      path: resolve(FIXTURES, "girr-small.csv"),
      format: "csv",
      mapping: {
        fields: {
          risk_class: { from: "risk_class" },
          bucket: { from: "bucket" },
          sensitivity_type: { from: "sensitivity_type" },
        },
      },
      onProgress: (n) => events.push(n),
      progressEvery: 2,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe(6);
  });
});
