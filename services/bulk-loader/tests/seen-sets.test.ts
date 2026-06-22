// Wave 7.0.6.13a — bulk-loader seen-set SADD emission.
//
// The bulk-loader writer co-pipelines three SADDs alongside every HSET so
// the discovery layer (`seen:risk_class`, `seen:bucket:<rc>`,
// `seen:sens_type:<rc>:<bkt>`) stays populated for calc / facets. These
// tests exercise the writer-level invariants:
//   * For a multi-row, multi-combo batch, every (rc), (rc, bkt) and
//     (rc, bkt, sens) tuple observed appears in the corresponding fake-
//     recorded SADDs.
//   * HSET and the three SADDs for a row are emitted on the same pipeline
//     (one `pipeline.exec()` for the batch contains both kinds of
//     commands, with the SADDs immediately following their HSET).
//   * A malformed row (missing all writable fields) is dead-lettered
//     without emitting any SADD — the discovery sets are never partially
//     populated.
//   * Per-worker counters (`seenSaddsEmitted`, `seenSaddsFailed`) match
//     the recorded outcomes and are surfaced as top-level sums on
//     /load/status.

import { describe, it, expect } from "vitest";
import { createWorker, type Row } from "../src/worker.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { createWorkerPool } from "../src/pool.ts";
import { createBulkLoaderState } from "../src/swap-target.ts";
import { createServer } from "../src/server.ts";
import { FakeWriteClient } from "./helpers/fake-write-client.ts";
import { FakeClient } from "./helpers/fake-client.ts";

function row(
  id: string,
  rc: string,
  bkt: string,
  sens: "Delta" | "Vega" | "Curvature",
  rv: Row["risk_value"] = { spot: 1 },
): Row {
  return { id, risk_class: rc, bucket: bkt, sensitivity_type: sens, risk_value: rv };
}

describe("Wave 7.0.6.13a — bulk writer emits seen-set SADDs", () => {
  it("populates seen:risk_class / seen:bucket:<rc> / seen:sens_type:<rc>:<bkt> across 100 rows", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 100, idleFlushMs: 0 });
    // Cover three risk classes, several buckets per class, and two sens
    // types per (rc, bkt) — enough to exercise the dedup and nested-key
    // shape without being noisy. 100 rows total.
    const combos: Array<[string, string, "Delta" | "Vega"]> = [
      ["GIRR", "USD", "Delta"], ["GIRR", "USD", "Vega"],
      ["GIRR", "EUR", "Delta"], ["GIRR", "JPY", "Delta"],
      ["EQUITY", "1", "Delta"], ["EQUITY", "2", "Delta"], ["EQUITY", "1", "Vega"],
      ["FX", "USDEUR", "Delta"], ["FX", "USDJPY", "Delta"], ["FX", "USDGBP", "Delta"],
    ];
    for (let i = 0; i < 100; i++) {
      const c = combos[i % combos.length]!;
      const rv: Row["risk_value"] = c[0] === "GIRR" ? { "3M": 0.1 } : { spot: 1 };
      w.push(row(`u${i}`, c[0], c[1], c[2], rv));
    }
    await w.drain();
    await w.stop();

    // Bucket the recorded SADDs into the three discovery keys.
    const riskClasses = new Set<string>();
    const bucketsByRc = new Map<string, Set<string>>();
    const sensByRcBkt = new Map<string, Set<string>>();
    for (const s of client.sadds) {
      if (s.key === "seen:risk_class") {
        riskClasses.add(s.member);
      } else if (s.key.startsWith("seen:bucket:")) {
        const rc = s.key.slice("seen:bucket:".length);
        let bs = bucketsByRc.get(rc);
        if (!bs) { bs = new Set(); bucketsByRc.set(rc, bs); }
        bs.add(s.member);
      } else if (s.key.startsWith("seen:sens_type:")) {
        const tail = s.key.slice("seen:sens_type:".length);
        let ss = sensByRcBkt.get(tail);
        if (!ss) { ss = new Set(); sensByRcBkt.set(tail, ss); }
        ss.add(s.member);
      }
    }

    expect(riskClasses).toEqual(new Set(["GIRR", "EQUITY", "FX"]));
    expect(bucketsByRc.get("GIRR")).toEqual(new Set(["USD", "EUR", "JPY"]));
    expect(bucketsByRc.get("EQUITY")).toEqual(new Set(["1", "2"]));
    expect(bucketsByRc.get("FX")).toEqual(new Set(["USDEUR", "USDJPY", "USDGBP"]));
    expect(sensByRcBkt.get("GIRR:USD")).toEqual(new Set(["Delta", "Vega"]));
    expect(sensByRcBkt.get("GIRR:EUR")).toEqual(new Set(["Delta"]));
    expect(sensByRcBkt.get("EQUITY:1")).toEqual(new Set(["Delta", "Vega"]));
    expect(sensByRcBkt.get("FX:USDEUR")).toEqual(new Set(["Delta"]));

    // Per-worker counter — 3 SADDs per row × 100 rows.
    expect(w.metrics().seenSaddsEmitted).toBe(300);
    expect(w.metrics().seenSaddsFailed).toBe(0);
    expect(w.metrics().flushed).toBe(100);
  });

  it("HSET + three SADDs for a row share the same pipeline.exec()", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 1, idleFlushMs: 0 });
    w.push(row("u1", "GIRR", "USD", "Delta", { "3M": 0.1 }));
    await w.drain();
    await w.stop();

    // batchSize=1 → exactly one exec for the single row, containing the
    // HSET followed by three SADDs in pipeline order.
    expect(client.execs).toHaveLength(1);
    const exec = client.execs[0]!;
    expect(exec.hsets).toHaveLength(1);
    expect(exec.sadds).toHaveLength(3);
    expect(exec.commands[0]?.type).toBe("HSET");
    expect(exec.commands[1]?.type).toBe("SADD");
    expect(exec.commands[2]?.type).toBe("SADD");
    expect(exec.commands[3]?.type).toBe("SADD");
    // Key shapes mirror `emitSeenSadds`.
    expect(exec.sadds[0]).toEqual({ key: "seen:risk_class", member: "GIRR" });
    expect(exec.sadds[1]).toEqual({ key: "seen:bucket:GIRR", member: "USD" });
    expect(exec.sadds[2]).toEqual({ key: "seen:sens_type:GIRR:USD", member: "Delta" });
  });

  it("malformed row (no writable fields) is dead-lettered AND emits no SADDs", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 1, idleFlushMs: 0 });
    // Construct a row whose `rowToHashFields` returns []: missing every
    // TAG field (including risk_class) and missing risk_value. The
    // writer's existing dead-letter path catches it before any HSET is
    // pipelined, and the seen-set guard skips SADDs because rc/bkt/sens
    // are all empty/undefined.
    const malformed = { id: "u-bad" } as unknown as Row;
    w.push(malformed);
    await w.drain();
    await w.stop();

    expect(w.metrics().deadLettered).toBe(1);
    expect(client.sadds).toHaveLength(0);
    expect(client.hsets).toHaveLength(0);
    // No pipeline exec is fired when the only row in the batch is
    // malformed — guard against partial-state pollution.
    expect(client.execs).toHaveLength(0);
    expect(w.metrics().seenSaddsEmitted).toBe(0);
    expect(w.metrics().seenSaddsFailed).toBe(0);
  });

  it("/load/status surfaces seen_sadds_emitted > 0 and seen_sadds_failed == 0 on a happy ingest", async () => {
    const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
    const fakePool: FakeClient[] = [];
    const pool = createWorkerPool({
      size: 2,
      redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
      heartbeatMs: 60_000,
      logger: { info: () => { } },
    });
    fakePool[0]!.becomeReady();
    fakePool[1]!.becomeReady();
    const dispatcher = createDispatcher({
      workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
    });
    const state = createBulkLoaderState({
      pool, dispatcher, checkpointer: null,
      bootstrapCheckpoints: new Map(),
      boundTarget: { host: "127.0.0.1", port: 12000, label: "test" },
      targetWatcher: "enabled",
    });
    const app = await createServer({ state });
    await app.ready();
    try {
      await dispatcher.enqueue(row("u1", "GIRR", "USD", "Delta", { "3M": 0.1 }));
      await dispatcher.enqueue(row("u2", "EQUITY", "1", "Delta", { spot: 5 }));
      await dispatcher.drain();
      const res = await app.inject({ method: "GET", url: "/load/status" });
      const body = res.json() as {
        seen_sadds_emitted: number;
        seen_sadds_failed: number;
        workers: Array<{
          id: number;
          seen_sadds_emitted: number | null;
          seen_sadds_failed: number | null;
        }>;
      };
      // Two rows × three SADDs each = 6 emitted, 0 failed.
      expect(body.seen_sadds_emitted).toBe(6);
      expect(body.seen_sadds_failed).toBe(0);
      // Per-worker fan-out is round-robin so each worker handles one row.
      expect(body.workers[0]?.seen_sadds_emitted).toBe(3);
      expect(body.workers[1]?.seen_sadds_emitted).toBe(3);
      expect(body.workers[0]?.seen_sadds_failed).toBe(0);
      expect(body.workers[1]?.seen_sadds_failed).toBe(0);
    } finally {
      await app.close(); await dispatcher.stop(); await pool.stop();
    }
  });
});
