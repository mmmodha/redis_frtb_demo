// Wave 6.39.A — direct-write mode bypasses the Redis Stream. The writer
// issues HSET (per STORAGE_FORMAT) + pre-aggregated HINCRBYFLOAT + SADD on
// the cluster pipeline directly. Asserted here via a stub pipeline recorder
// so the test stays self-contained and bit-exact about command shape /
// command count (no live redis required).
//
// Cross-service DI: hooks (enrichDoc / writeDocForStorage / buildKey) are
// imported from services/ingest/src/consumer.ts. This is intentional — the
// storage shape is owned by ingest; the direct-writer reuses the same writer
// dispatcher so all four STORAGE_FORMAT variants produce identical doc shape
// to the stream-mode consumer (zero drift).

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import {
  enrichDoc,
  writeDocForStorage,
  buildKey,
} from "../../ingest/src/consumer.ts";
import { createRowGenerator } from "../src/row-generator.ts";
import { createDirectWriter } from "../src/direct-writer.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
let schema: Schema;
beforeAll(() => {
  schema = loadSchema(resolve(here, "fixtures/multi-class.yaml"));
});

// Stub pipeline recorder. Captures every command + arg-tuple per exec.
type Cmd = [string, ...unknown[]];
type StubClient = {
  execCalls: Cmd[][];
  pipeline(): {
    call(cmd: string, ...args: unknown[]): unknown;
    hset(...args: unknown[]): unknown;
    sadd(...args: unknown[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]>>;
  };
};
function stubClient(): StubClient {
  const execCalls: Cmd[][] = [];
  return {
    execCalls,
    pipeline() {
      const buffered: Cmd[] = [];
      const api = {
        call(cmd: string, ...args: unknown[]): unknown {
          buffered.push([cmd, ...args]);
          return api;
        },
        hset(...args: unknown[]): unknown {
          buffered.push(["HSET", ...args]);
          return api;
        },
        sadd(...args: unknown[]): unknown {
          buffered.push(["SADD", ...args]);
          return api;
        },
        async exec(): Promise<Array<[Error | null, unknown]>> {
          execCalls.push(buffered.slice());
          buffered.length = 0;
          return execCalls[execCalls.length - 1]!.map(() => [null, "OK"] as [Error | null, unknown]);
        },
      };
      return api;
    },
  };
}

const hooks = { enrichDoc, writeDocForStorage, buildKey };

describe("createDirectWriter — HSET + pre-aggregated HINCRBYFLOAT (Wave 6.39.A)", () => {
  it("writes one HSET per row + ONE HINCRBYFLOAT per unique (rollupKey, field) tuple per flush", async () => {
    const client = stubClient();
    const gen = createRowGenerator(schema, {
      seed: 42, distribution: "uniform",
      sensitivityTypes: ["Delta"],
    });
    const writer = createDirectWriter(client as never, {
      schema, storageFormat: "hash-sidetable", batchSize: 100, hooks,
    });
    // 100 GIRR rows, 3 buckets → 3 unique (rc, bkt, Delta) tuples.
    for (let i = 0; i < 100; i++) await writer.add(gen.generate("GIRR"));
    await writer.flush();
    expect(client.execCalls).toHaveLength(1);
    const cmds = client.execCalls[0]!;
    const hsetCount = cmds.filter((c) => c[0] === "HSET").length;
    const hincrCount = cmds.filter((c) => c[0] === "HINCRBYFLOAT").length;
    // 100 rows × 1 sens-doc HSET each = 100; per-tenor sidetable adds up to
    // 100 more (one per row for GIRR). Always ≥ 100, never more than 200.
    expect(hsetCount).toBeGreaterThanOrEqual(100);
    expect(hsetCount).toBeLessThanOrEqual(200);
    // GIRR Delta rollup: scalar key + per-tenor keys. Pre-aggregation MUST
    // dedupe so the count is bounded by unique-(key, field) tuples, not by
    // the 100 input rows × 3 fields = 300 the naive per-row writer emits.
    expect(hincrCount).toBeLessThan(100); // ~ 3 buckets × (3 scalar + 3 tenor × 3) ≤ 36
    expect(writer.rowsSent).toBe(100);
  });

  it("emits ≤ unique-(rc,bkt) + unique-(rc,bkt,sens) SADDs per flush (not per row)", async () => {
    const client = stubClient();
    const gen = createRowGenerator(schema, {
      seed: 7, distribution: "uniform", sensitivityTypes: ["Delta"],
    });
    const writer = createDirectWriter(client as never, {
      schema, storageFormat: "hash-sidetable", batchSize: 200, hooks,
    });
    for (let i = 0; i < 200; i++) await writer.add(gen.generate("GIRR"));
    await writer.flush();
    const cmds = client.execCalls[0]!;
    const saddCount = cmds.filter((c) => c[0] === "SADD").length;
    // 1 (risk_class) + 3 (buckets) + 3 (sens_type per bkt) = 7. Cap at 16
    // gives plenty of headroom for jitter; the point is "<< 200".
    expect(saddCount).toBeLessThanOrEqual(16);
  });

  it("rowsSent + byClass counters track add() calls", async () => {
    const client = stubClient();
    const gen = createRowGenerator(schema, { seed: 1, distribution: "uniform" });
    const writer = createDirectWriter(client as never, {
      schema, storageFormat: "hash-sidetable", batchSize: 25, hooks,
    });
    for (let i = 0; i < 25; i++) await writer.add(gen.generate("FX"));
    await writer.flush();
    expect(writer.rowsSent).toBe(25);
    expect(writer.byClass.FX).toBe(25);
    expect(writer.batchCount).toBe(1);
  });

  it("every row carries the `desk` field through to the HSET (parent doc)", async () => {
    const client = stubClient();
    const gen = createRowGenerator(schema, { seed: 99, distribution: "uniform" });
    const writer = createDirectWriter(client as never, {
      schema, storageFormat: "hash-sidetable", batchSize: 10, hooks,
    });
    for (let i = 0; i < 10; i++) await writer.add(gen.generate("EQUITY"));
    await writer.flush();
    const cmds = client.execCalls[0]!;
    const parentHsets = cmds.filter((c) =>
      c[0] === "HSET" && typeof c[1] === "string" && c[1].startsWith("sens:") &&
      !(c[1] as string).endsWith(":tenors")
    );
    expect(parentHsets.length).toBe(10);
    for (const hset of parentHsets) {
      const args = hset.slice(2) as string[];
      const i = args.indexOf("desk");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toMatch(/^EQUITY_(LDN|NYC|HKG)$/);
    }
  });
});
